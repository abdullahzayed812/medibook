import { Router } from 'express';
import type { AppConfig } from './config/env.js';
import type { Database } from './infrastructure/database/database.js';
import type { Redis } from './infrastructure/redis/redis.js';
import type { Logger } from './shared/logger/logger.js';
import { systemClock, type Clock } from './shared/security/clock.js';
import { RedisRateLimiter, type RateLimiter } from './shared/security/rate-limiter.js';
import {
  AuthorizationService,
  clinicContext,
  type ClinicOperationGate,
  createAccessRouter,
  MembershipService,
  MembershipsRepository,
  TenantContextResolver,
} from './modules/access/index.js';
import { AuditLog, SecurityEventLog } from './modules/audit/index.js';
import {
  AccessTokenService,
  AccountService,
  AuthService,
  authenticate,
  createEnvKeyStore,
  createIamRouter,
  createOtpProvider,
  MfaService,
  OtpService,
  SessionService,
  UsersRepository,
  type AccessTokenKeyStore,
  type OtpProvider,
} from './modules/iam/index.js';
import { createRegistrationRouter } from './modules/clinic-registration/registration.routes.js';
import { RegistrationService } from './modules/clinic-registration/registration.service.js';
import { BranchesRepository } from './modules/clinics/branches.repository.js';
import { ClinicService } from './modules/clinics/clinic.service.js';
import { createClinicsRouter } from './modules/clinics/clinics.routes.js';
import { ClinicsRepository } from './modules/clinics/clinics.repository.js';
import { ClinicLifecycleService } from './modules/clinics/lifecycle.service.js';
import { ClinicOperationGateImpl } from './modules/clinics/operation-gate.js';
import { ClinicPlatformService } from './modules/clinics/platform.service.js';
import { createDoctorProfilesRouter } from './modules/doctor-profiles/doctor-profiles.routes.js';
import {
  DoctorProfileService,
  SpecialtyService,
} from './modules/doctor-profiles/doctor-profiles.service.js';
import { createMarketplaceRouter } from './modules/marketplace/marketplace.routes.js';
import { MarketplaceService } from './modules/marketplace/marketplace.service.js';
import { createOwnershipTransferRouter } from './modules/ownership-transfer/ownership-transfer.routes.js';
import { OwnershipTransferService } from './modules/ownership-transfer/ownership-transfer.service.js';
import { PatientProfilesRepository } from './modules/patient-profiles/index.js';
import { createPlatformAdminRouter } from './modules/platform-admin/index.js';
import {
  DomainEventOutbox,
  LocalPrivateStorage,
  PlatformSettingsService,
  PrivateDocuments,
  type PrivateObjectStorage,
} from './modules/platform/index.js';
import { DoctorAssignmentService } from './modules/clinic-setup/assignments.service.js';
import { ServiceCatalogService } from './modules/clinic-setup/catalog.service.js';
import { ScheduleService } from './modules/clinic-setup/schedules.service.js';
import { createClinicSetupRouter } from './modules/clinic-setup/setup.routes.js';
import { PhoneChangeService } from './modules/iam/phone-change.service.js';
import { AvailabilityService } from './modules/bookings/availability.js';
import { createBookingsRouter } from './modules/bookings/bookings.routes.js';
import { BookingService } from './modules/bookings/bookings.service.js';
import { IdentityAdminService } from './modules/bookings/identity-links.js';
import { PersonsService } from './modules/bookings/persons.service.js';
import { BookingSettingsService } from './modules/bookings/settings.service.js';
import { createStaffRouter } from './modules/staff/staff.routes.js';
import { StaffService } from './modules/staff/staff.service.js';
import { createSubscriptionsRouter } from './modules/subscriptions/subscriptions.routes.js';
import {
  PlansService,
  SubscriptionService,
  SubscriptionsRepository,
} from './modules/subscriptions/index.js';

export interface ContainerOptions {
  readonly config: AppConfig;
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  /** Overrides for tests. */
  readonly clock?: Clock;
  readonly otpProvider?: OtpProvider;
  readonly keyStore?: AccessTokenKeyStore;
  readonly rateLimiter?: RateLimiter;
  readonly storage?: PrivateObjectStorage;
}

/**
 * Composition root for the business API: builds repositories → services → routers.
 * The only place where concrete implementations are chosen.
 */
export function createContainer(options: ContainerOptions) {
  const { config, db, logger } = options;
  const clock = options.clock ?? systemClock;

  const securityEvents = new SecurityEventLog();
  const auditLog = new AuditLog();
  const rateLimiter =
    options.rateLimiter ?? new RedisRateLimiter(options.redis, `${config.queue.prefix}:auth`);
  const users = new UsersRepository();
  const memberships = new MembershipsRepository();

  const tokens = new AccessTokenService(
    options.keyStore ?? createEnvKeyStore(config.auth.accessToken),
    config.auth.accessToken,
    clock,
  );
  const sessions = new SessionService({ db, securityEvents, config: config.auth, clock });
  const otp = new OtpService({
    db,
    provider: options.otpProvider ?? createOtpProvider(config, logger),
    rateLimiter,
    securityEvents,
    config: config.otp,
    authSecret: config.auth.secret,
    clock,
    logger,
  });
  const auth = new AuthService({ db, otp, sessions, tokens, users, securityEvents, clock });
  const accounts = new AccountService({ db, users, sessions, securityEvents, auditLog, clock });
  const mfa = new MfaService({
    db,
    sessions,
    securityEvents,
    auditLog,
    rateLimiter,
    config: config.mfa,
    authSecret: config.auth.secret,
    clock,
  });
  // The clinic operation gate depends on subscriptions, which depend on authorization: the
  // gate is bound into this typed holder below, before any request can be served.
  const gateHolder: { current: ClinicOperationGate | undefined } = { current: undefined };
  const authz = new AuthorizationService(db, {
    evaluate: (input) => {
      if (gateHolder.current === undefined)
        throw new Error('Clinic operation gate not initialised');
      return gateHolder.current.evaluate(input);
    },
  });
  const resolver = new TenantContextResolver(db, memberships, clock);
  const outbox = new DomainEventOutbox();
  const settings = new PlatformSettingsService(db, authz, auditLog);
  const subscriptionsRepo = new SubscriptionsRepository();
  const subscriptionDeps = {
    db,
    repo: subscriptionsRepo,
    authz,
    settings,
    auditLog,
    outbox,
    clock,
  };
  const plans = new PlansService(subscriptionDeps);
  const subscriptions = new SubscriptionService(subscriptionDeps);
  const clinicsRepo = new ClinicsRepository();
  const branches = new BranchesRepository();
  const gate = new ClinicOperationGateImpl(db, clinicsRepo, subscriptions, clock);
  gateHolder.current = gate;

  const membershipService = new MembershipService({
    db,
    memberships,
    resolver,
    authz,
    auditLog,
    clock,
    hooks: {
      assertCanActivate: async (tx, clinicId, userId) => {
        const active = await tx.query(
          `SELECT id FROM clinic_memberships WHERE clinic_id = ? AND user_id = ? AND status = 'ACTIVE' LIMIT 1`,
          [clinicId, userId],
        );
        if (active.length === 0)
          await subscriptions.assertCanGrow(tx, clinicId, 'max_active_members');
      },
      // No module owns outstanding work yet (bookings/queue arrive in later tasks).
      outstandingResponsibilities: () => Promise.resolve([]),
    },
  });

  const storage = options.storage ?? new LocalPrivateStorage(config.storage.localDir, config.env);
  const documents = {
    registration: new PrivateDocuments(storage, {
      table: 'clinic_registration_documents',
      parentColumn: 'registration_request_id',
      keyPrefix: 'registration',
      types: ['BUSINESS_LICENSE', 'FACILITY_LICENSE', 'OWNER_IDENTITY', 'TAX_CERTIFICATE', 'OTHER'],
    }),
    doctor: new PrivateDocuments(storage, {
      table: 'doctor_verification_documents',
      parentColumn: 'doctor_profile_id',
      keyPrefix: 'doctor-verification',
      types: [
        'MEDICAL_LICENSE',
        'DEGREE_CERTIFICATE',
        'IDENTITY',
        'SPECIALTY_CERTIFICATE',
        'OTHER',
      ],
    }),
    transfer: new PrivateDocuments(storage, {
      table: 'ownership_transfer_documents',
      parentColumn: 'transfer_id',
      keyPrefix: 'ownership-transfer',
      types: ['TRANSFER_AGREEMENT', 'NEW_OWNER_IDENTITY', 'CURRENT_OWNER_IDENTITY', 'OTHER'],
    }),
  };

  const registrations = new RegistrationService({
    db,
    authz,
    documents: documents.registration,
    memberships,
    branches,
    subscriptions,
    settings,
    auditLog,
    outbox,
    clock,
  });
  const clinicService = new ClinicService({
    db,
    clinics: clinicsRepo,
    branches,
    authz,
    gate,
    subscriptions,
    auditLog,
    outbox,
  });
  const clinicPlatform = new ClinicPlatformService(db, clinicsRepo, branches, subscriptions, authz);
  const transfers = new OwnershipTransferService({
    db,
    authz,
    memberships,
    documents: documents.transfer,
    settings,
    auditLog,
    outbox,
    clock,
  });
  const staff = new StaffService({
    db,
    authz,
    resolver,
    memberships,
    membershipService,
    subscriptions,
    settings,
    auditLog,
    outbox,
    clock,
  });
  const lifecycle = new ClinicLifecycleService({
    db,
    clinics: clinicsRepo,
    authz,
    settings,
    auditLog,
    outbox,
    clock,
    onClosing: [
      (tx, clinicId, actorId, meta) => staff.revokePendingForClinic(tx, clinicId, actorId, meta),
      (tx, clinicId, actorId, meta) => transfers.cancelOpenForClinic(tx, clinicId, actorId, meta),
    ],
    onClosed: [
      (tx, clinicId, actorId, meta) => subscriptions.expireForClosure(tx, clinicId, actorId, meta),
    ],
  });
  const doctors = new DoctorProfileService({
    db,
    authz,
    documents: documents.doctor,
    auditLog,
    clock,
  });
  const specialties = new SpecialtyService(db, authz, auditLog);
  const marketplace = new MarketplaceService({
    db,
    clinics: clinicsRepo,
    subscriptions,
    doctors,
    authz,
    auditLog,
    outbox,
  });
  const patientProfiles = new PatientProfilesRepository();
  const authenticateMw = authenticate(tokens, sessions, clock);

  const apiRouter = Router();
  apiRouter.use(
    createIamRouter({
      db,
      authenticate: authenticateMw,
      auth,
      otp,
      sessions,
      accounts,
      mfa,
      securityEvents,
      otpConfig: config.otp,
      phoneChange: new PhoneChangeService({ db, otp, auditLog }),
    }),
  );
  apiRouter.use(
    createAccessRouter({
      db,
      authenticate: authenticateMw,
      authz,
      resolver,
      memberships,
      sessions,
      securityEvents,
      globalRoles: (userId) => users.listGlobalRoles(db, userId),
      clock,
    }),
  );
  apiRouter.use(createPlatformAdminRouter({ authenticate: authenticateMw, authz, accounts }));

  // Task 03: platform & clinic management
  const ctx = clinicContext(resolver);
  const phoneDefaultRegion = config.otp.phoneDefaultRegion;
  apiRouter.use(createRegistrationRouter({ authenticate: authenticateMw, registrations }));
  apiRouter.use(
    createClinicsRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      clinics: clinicService,
      lifecycle,
      platform: clinicPlatform,
    }),
  );
  apiRouter.use(
    createOwnershipTransferRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      transfers,
      phoneDefaultRegion,
    }),
  );
  apiRouter.use(createDoctorProfilesRouter({ authenticate: authenticateMw, doctors, specialties }));
  apiRouter.use(
    createStaffRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      staff,
      phoneDefaultRegion,
    }),
  );
  apiRouter.use(
    createSubscriptionsRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      plans,
      subscriptions,
      settings,
    }),
  );
  apiRouter.use(
    createMarketplaceRouter({ authenticate: authenticateMw, clinicContext: ctx, marketplace }),
  );

  // Task 04: doctors, services, branch hours and schedules
  const setupDeps = {
    db,
    authz,
    resolver,
    auditLog,
    outbox,
    settings,
    clock,
    lockClinic: (tx: Parameters<MembershipService['lockClinic']>[0], clinicId: string) =>
      membershipService.lockClinic(tx, clinicId),
  };
  const doctorAssignments = new DoctorAssignmentService(setupDeps);
  const serviceCatalog = new ServiceCatalogService(setupDeps);
  const scheduling = new ScheduleService(setupDeps);
  // Task 05: booking engine
  const persons = new PersonsService({ db, otp, auditLog, clock, rateLimiter, authz });
  const availability = new AvailabilityService({ db, gate, clock });
  const bookings = new BookingService({
    db,
    authz,
    resolver,
    gate,
    persons,
    auditLog,
    outbox,
    clock,
  });
  const bookingSettings = new BookingSettingsService({ db, authz, auditLog });
  apiRouter.use(
    createBookingsRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      availability,
      bookings,
      persons,
      settings: bookingSettings,
      identityAdmin: new IdentityAdminService({ db, authz, auditLog, securityEvents, clock }),
      phoneDefaultRegion,
    }),
  );
  apiRouter.use(
    createClinicSetupRouter({
      authenticate: authenticateMw,
      clinicContext: ctx,
      assignments: doctorAssignments,
      catalog: serviceCatalog,
      schedules: scheduling,
    }),
  );

  return {
    db,
    apiRouter,
    authenticate: authenticateMw,
    services: {
      auth,
      accounts,
      sessions,
      otp,
      mfa,
      tokens,
      authz,
      resolver,
      membershipService,
      settings,
      plans,
      subscriptions,
      registrations,
      clinics: clinicService,
      clinicPlatform,
      lifecycle,
      transfers,
      staff,
      doctors,
      specialties,
      marketplace,
      gate,
      doctorAssignments,
      serviceCatalog,
      scheduling,
      persons,
      availability,
      bookings,
      bookingSettings,
    },
    repositories: { users, memberships, patientProfiles, clinics: clinicsRepo, branches },
    logs: { securityEvents, auditLog, outbox },
  };
}

export type Container = ReturnType<typeof createContainer>;
