import type { Database, SqlExecutor } from '../../infrastructure/database/database.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/app-error.js';
import { toPage } from '../../shared/http/pagination.js';
import type { RequestMeta } from '../../shared/http/request-meta.js';
import type { Clock } from '../../shared/security/clock.js';
import type {
  AuthorizationService,
  Principal,
  TenantContext,
  TenantContextResolver,
} from '../access/index.js';
import { AUDIT_ACTION, type AuditLog } from '../audit/index.js';
import { authorizeBranch, branchTenant } from '../clinic-setup/context.js';
import { localTime } from '../clinic-setup/time-zone.js';
import { formatClock } from '../clinic-setup/weekly.js';
import type { ClinicOperationGateImpl } from '../clinics/operation-gate.js';
import type { DomainEventOutbox } from '../platform/index.js';
import {
  doctorBusy,
  fitsWorkingTime,
  loadCandidates,
  identityBusy,
  slotsFor,
  type Candidate,
} from './availability.js';
import {
  claimIdempotencyKey,
  IdempotencyRace,
  IdempotentReplay,
  isDuplicateKey,
  type IdempotencyContext,
} from './idempotency.js';
import { lockIdentityOfPerson } from './identity-links.js';
import type { ActingAs, GuestSession, PersonRow, PersonsService } from './persons.service.js';
import {
  BOOKING_LIFECYCLE,
  cancellationPolicyOf,
  confirmationDeadline,
  evaluatePatientCancellation,
  type ActorKind,
  type BookingStatus,
  type CancellationPolicy,
} from './policy.js';

/**
 * Booking Engine (slot mode). See docs/platform/BOOKINGS.md.
 *
 * Transactions run at READ COMMITTED (every statement sees the latest committed state once the
 * locks below are held) and are retried on deadlock. LOCK ORDER (always, every write):
 *   1. idempotency key row            (per actor; first statement)
 *   2. clinic row       FOR SHARE     (serializes against clinic-setup writes, which take it
 *                                      FOR UPDATE; bookings do not block each other here)
 *   3. doctor profile(s) FOR UPDATE   (GLOBAL: serializes the doctor across ALL clinics;
 *                                      several doctors in ascending id order)
 *   4. booking person   FOR UPDATE    (GLOBAL: serializes the patient across all clinics)
 *   5. booking rows     FOR UPDATE    (ascending id)
 * Reject, cancel and expire only release capacity: they lock just the booking rows (step 5),
 * which cannot form a cycle with the order above.
 */

type Row = Record<string, unknown>;

export interface SlotRequest {
  readonly clinicId: string;
  readonly branchId: string;
  readonly serviceId: string;
  readonly assignmentId: string;
  readonly startsAt: string;
  readonly note?: string | null | undefined;
}

interface BookingActor {
  readonly kind: ActorKind;
  readonly userId: string | null;
  readonly guestSessionId: string | null;
  /**
   * The beneficiary. `resolve` (staff bookings) determines it INSIDE the booking transaction,
   * after the doctor locks, so a new clinic-recorded person and its booking commit together.
   */
  readonly person: PersonRow | null;
  readonly resolve?: (tx: SqlExecutor) => Promise<PersonRow>;
  /** Stable identity of the beneficiary for the idempotency payload. */
  readonly beneficiaryKey: string;
  readonly delegationId: string | null;
  readonly relationship: string | null;
  readonly contactPhone: string | null;
  readonly idemScope: string;
}

interface BookingRecord {
  id: string;
  clinicId: string;
  branchId: string;
  status: BookingStatus;
  personId: string;
  doctorProfileId: string;
  assignmentId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  blockEndsAt: Date;
  deadline: Date;
  policy: CancellationPolicy;
  rescheduleOf: string | null;
  supersededBy: string | null;
  row: Row;
}

const toRecord = (r: Row): BookingRecord => ({
  id: String(r.id),
  clinicId: String(r.clinic_id),
  branchId: String(r.branch_id),
  status: r.status as BookingStatus,
  personId: String(r.person_id),
  doctorProfileId: String(r.doctor_profile_id),
  assignmentId: String(r.assignment_id),
  serviceId: String(r.service_id),
  startsAt: r.starts_at as Date,
  endsAt: r.ends_at as Date,
  blockEndsAt: r.block_ends_at as Date,
  deadline: r.confirmation_deadline as Date,
  policy: r.cancellation_policy as CancellationPolicy,
  rescheduleOf: (r.reschedule_of_booking_id as string | null) ?? null,
  supersededBy: (r.superseded_by_booking_id as string | null) ?? null,
  row: r,
});

const BOOKING_SELECT = `
  SELECT b.*, c.name AS clinic_name, br.name AS branch_name, pp.display_name AS patient_name, bp.display_name AS person_name
    FROM bookings b
    JOIN clinics c ON c.id = b.clinic_id
    JOIN clinic_branches br ON br.id = b.branch_id AND br.clinic_id = b.clinic_id
    JOIN patient_profiles pp ON pp.id = b.patient_profile_id AND pp.clinic_id = b.clinic_id
    JOIN booking_persons bp ON bp.id = b.person_id`;

function localView(r: Row) {
  const tz = r.time_zone as string;
  const s = localTime(tz, (r.starts_at as Date).getTime());
  const e = localTime(tz, (r.ends_at as Date).getTime());
  return { date: s.date, start: formatClock(s.minute), end: formatClock(e.minute) };
}

function commonView(r: Row) {
  const policy = r.cancellation_policy as CancellationPolicy;
  const startsAt = r.starts_at as Date;
  return {
    id: String(r.id),
    mode: r.mode as string,
    status: r.status as BookingStatus,
    clinic: { id: String(r.clinic_id), name: r.clinic_name as string },
    branch: {
      id: String(r.branch_id),
      name: r.branch_name as string,
      timeZone: r.time_zone as string,
    },
    doctor: { displayName: r.doctor_display_name as string },
    service: {
      id: String(r.service_id),
      name: {
        en: (r.service_name_en as string | null) ?? null,
        ar: (r.service_name_ar as string | null) ?? null,
      },
    },
    assignmentId: String(r.assignment_id),
    startsAt: startsAt.toISOString(),
    endsAt: (r.ends_at as Date).toISOString(),
    local: localView(r),
    durationMinutes: Number(r.duration_minutes),
    price: { amountMinor: Number(r.price_minor), currency: r.currency as string },
    confirmationDeadline: (r.confirmation_deadline as Date).toISOString(),
    cancellationPolicy: {
      ...policy,
      patientCancelUntil: new Date(
        startsAt.getTime() - policy.minNoticeMinutes * 60_000,
      ).toISOString(),
    },
    rescheduleOfBookingId: (r.reschedule_of_booking_id as string | null) ?? null,
    supersededByBookingId: (r.superseded_by_booking_id as string | null) ?? null,
    statusReason: (r.status_reason as string | null) ?? null,
    statusChangedAt: (r.status_changed_at as Date).toISOString(),
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/** What the patient (or their delegate / guest) sees: no clinic-internal identifiers. */
export function patientView(r: Row) {
  return {
    ...commonView(r),
    patient: { personId: String(r.person_id), displayName: r.person_name as string },
    bookedBy: {
      kind: r.actor_kind as string,
      relationship: (r.relationship as string | null) ?? null,
    },
  };
}

/** What clinic staff see: their own clinic's booking with its clinic patient profile. */
export function clinicView(r: Row) {
  return {
    ...commonView(r),
    patient: {
      patientProfileId: String(r.patient_profile_id),
      displayName: r.patient_name as string,
      contactPhone: (r.contact_phone_e164 as string | null) ?? null,
    },
    bookedBy: {
      kind: r.actor_kind as string,
      relationship: (r.relationship as string | null) ?? null,
    },
    patientNote: (r.patient_note as string | null) ?? null,
  };
}

export interface BookingsDeps {
  readonly db: Database;
  readonly authz: AuthorizationService;
  readonly resolver: TenantContextResolver;
  readonly gate: ClinicOperationGateImpl;
  readonly persons: PersonsService;
  readonly auditLog: AuditLog;
  readonly outbox: DomainEventOutbox;
  readonly clock: Clock;
}

const ERR = {
  slot: () => new AppError(409, 'SLOT_UNAVAILABLE', 'This time is no longer available'),
  patient: () =>
    new AppError(409, 'PATIENT_CONFLICT', 'The patient already has an appointment at this time'),
  closed: () =>
    new AppError(
      409,
      'CLINIC_NOT_ACCEPTING_BOOKINGS',
      'The clinic is not accepting bookings right now',
    ),
  expired: () => new AppError(409, 'BOOKING_EXPIRED', 'The confirmation deadline has passed'),
};

export class BookingService {
  constructor(private readonly deps: BookingsDeps) {}

  // =====================================================================================
  // Creation
  // =====================================================================================

  async createForUser(
    principal: Principal,
    input: SlotRequest & { personId?: string | undefined },
    idemKey: string,
    meta: RequestMeta,
  ) {
    const actor = await this.userActor(principal, input.personId, meta);
    return this.create(actor, input, idemKey, meta, null);
  }

  async createForGuest(
    session: GuestSession,
    input: SlotRequest & { patient: { displayName: string } },
    idemKey: string,
    meta: RequestMeta,
  ) {
    const person = await this.deps.persons.guestPerson(session, input.patient.displayName, meta);
    const actor: BookingActor = {
      kind: 'GUEST',
      userId: null,
      guestSessionId: session.sessionId,
      person,
      beneficiaryKey: `person:${person.id}`,
      delegationId: null,
      relationship: null,
      contactPhone: session.phoneE164,
      idemScope: `guest:${session.phoneHash}`,
    };
    const created = (await this.create(actor, input, idemKey, meta, null)) as { data: unknown };
    // The claim code is shown ONCE, here, and is never part of the stored idempotent response.
    const claim = await this.deps.persons.issueFirstClaimCode(person.id, meta);
    return claim === null ? created : { ...created, guestAccess: claim };
  }

  /**
   * Clinic staff create a booking for a patient of THEIR clinic: an existing clinic patient
   * profile, or a new clinic-recorded person (never matched to anyone by phone). Same engine,
   * locks, conflicts, gate, deadline and snapshots as patient bookings; the result is a PENDING
   * request that still needs confirmation. The staff user is the actor, the person the
   * beneficiary; no delegation and no medical-record access is created.
   */
  async createByStaff(
    principal: Principal,
    tenant: TenantContext,
    input: Omit<SlotRequest, 'clinicId'> & {
      patient:
        | { patientProfileId: string }
        | {
            new: {
              displayName: string;
              birthDate?: string | null | undefined;
              contactPhone?: string | null | undefined;
            };
          };
    },
    idemKey: string,
    meta: RequestMeta,
  ) {
    await authorizeBranch(this.deps, principal, tenant, input.branchId, 'clinic.bookings.manage');
    const clinicId = tenant.clinicId;
    const person: PersonRow | null = null;
    let contactPhone: string | null = null;
    let resolve: ((tx: SqlExecutor) => Promise<PersonRow>) | undefined;
    if ('patientProfileId' in input.patient) {
      const profileId = input.patient.patientProfileId;
      const profile = (
        await this.deps.db.query<{ id: string; person_id: string | null }>(
          'SELECT id, person_id FROM patient_profiles WHERE id = ? AND clinic_id = ?',
          [profileId, clinicId],
        )
      )[0];
      // A profile of another clinic is indistinguishable from a missing one.
      if (profile === undefined) throw new NotFoundError('Patient not found');
      resolve = async (tx) => {
        const locked = (
          await tx.query<{ person_id: string | null; display_name: string }>(
            'SELECT person_id, display_name FROM patient_profiles WHERE id = ? AND clinic_id = ? FOR UPDATE',
            [profileId, clinicId],
          )
        )[0];
        if (locked === undefined) throw new NotFoundError('Patient not found');
        if (locked.person_id !== null) {
          const p = (
            await tx.query<PersonRow>(
              `SELECT id, kind, user_id, claimed_by_user_id, identity_id, display_name, DATE_FORMAT(birth_date, '%Y-%m-%d') AS birth_date
                 FROM booking_persons WHERE id = ?`,
              [locked.person_id],
            )
          )[0];
          if (p === undefined) throw new NotFoundError('Patient not found');
          return p;
        }
        // Legacy profile without a person: a clinic-recorded person, linked to THIS profile only.
        const p = await this.deps.persons.insertClinicPerson(tx, principal.userId, {
          displayName: locked.display_name,
        });
        await tx.execute(
          'UPDATE patient_profiles SET person_id = ? WHERE id = ? AND clinic_id = ?',
          [p.id, profileId, clinicId],
        );
        return p;
      };
    } else {
      const fresh = input.patient.new;
      contactPhone = fresh.contactPhone ?? null;
      resolve = (tx) => this.deps.persons.insertClinicPerson(tx, principal.userId, fresh);
    }
    const actor: BookingActor = {
      kind: 'STAFF',
      userId: principal.userId,
      guestSessionId: null,
      person,
      resolve,
      beneficiaryKey:
        'patientProfileId' in input.patient
          ? `profile:${input.patient.patientProfileId}`
          : `new:${JSON.stringify(input.patient.new)}`,
      delegationId: null,
      relationship: null,
      contactPhone,
      idemScope: `user:${principal.userId}`,
    };
    const { patient: _patient, ...slot } = input;
    const result = (await this.create(actor, { ...slot, clinicId }, idemKey, meta, null)) as {
      data: { id: string };
    };
    return { data: clinicView(await this.loadRow(this.deps.db, result.data.id)) };
  }

  /** Replacement request for a CONFIRMED booking; the original stays CONFIRMED until accepted. */
  async requestReschedule(
    principal: Principal,
    bookingId: string,
    input: { startsAt: string; assignmentId?: string | undefined },
    idemKey: string,
    meta: RequestMeta,
  ) {
    const original = await this.loadForPatient(
      principal,
      bookingId,
      meta,
      'patient.bookings.manage_own',
    );
    const actor = await this.userActor(principal, original.personId, meta);
    return this.create(
      actor,
      {
        clinicId: original.clinicId,
        branchId: original.branchId,
        serviceId: original.serviceId,
        assignmentId: input.assignmentId ?? original.assignmentId,
        startsAt: input.startsAt,
      },
      idemKey,
      meta,
      original.id,
    );
  }

  private async userActor(
    principal: Principal,
    personId: string | undefined,
    meta: RequestMeta,
  ): Promise<BookingActor> {
    await this.deps.persons.ensurePatientRole(principal.userId, meta);
    await this.deps.authz.assert(principal, 'patient.bookings.manage_own');
    const self = await this.deps.persons.selfPerson(principal.userId, meta);
    const acting: ActingAs =
      personId === undefined || personId === self.id
        ? { kind: 'SELF', person: self }
        : await this.deps.persons.actingAs(this.deps.db, principal.userId, personId);
    const phone = (
      await this.deps.db.query<{ phone_e164: string }>(
        'SELECT phone_e164 FROM users WHERE id = ?',
        [principal.userId],
      )
    )[0];
    return {
      kind: acting.kind === 'SELF' ? 'SELF' : 'DELEGATE',
      userId: principal.userId,
      guestSessionId: null,
      person: acting.person,
      beneficiaryKey: `person:${acting.person.id}`,
      delegationId: acting.kind === 'DELEGATE' ? acting.delegationId : null,
      relationship: acting.kind === 'DELEGATE' ? acting.relationship : null,
      contactPhone: phone?.phone_e164 ?? null,
      idemScope: `user:${principal.userId}`,
    };
  }

  private async create(
    actor: BookingActor,
    input: SlotRequest,
    idemKey: string,
    meta: RequestMeta,
    rescheduleOf: string | null,
  ) {
    const startsAt = new Date(input.startsAt);
    return this.idempotent(
      {
        scope: actor.idemScope,
        operation: rescheduleOf === null ? 'booking.create' : `booking.reschedule:${rescheduleOf}`,
        key: idemKey,
        payload: { ...input, beneficiary: actor.beneficiaryKey },
      },
      async (tx) => {
        const now = this.deps.clock();
        await this.lockClinicShared(tx, input.clinicId);
        const candidate = await this.candidate(tx, input, true);
        // Plain read (no lock) only to learn the original's doctor; it is locked in step 5.
        const original =
          rescheduleOf === null ? null : await this.readBooking(tx, rescheduleOf, input.clinicId);
        // Lock order: doctors (ascending) → person → bookings.
        await this.lockDoctors(tx, [
          candidate.assignment.doctor_profile_id,
          ...(original ? [original.doctorProfileId] : []),
        ]);
        const person = actor.person ?? (await actor.resolve?.(tx));
        if (person === undefined) throw new Error('booking beneficiary missing');
        // Lock order: doctors → canonical identity → person (ADR-055).
        const identityId = await lockIdentityOfPerson(tx, person.id);
        if (actor.delegationId !== null) await this.assertDelegationActive(tx, actor.delegationId);
        if (original !== null) {
          const o = await this.lockedBooking(tx, original.id, input.clinicId);
          if (o.status !== 'CONFIRMED')
            throw new ConflictError('Only a confirmed booking can be rescheduled');
          if (o.personId !== person.id) throw new NotFoundError('Booking not found');
          const pending = await tx.query(
            `SELECT id FROM bookings WHERE reschedule_of_booking_id = ? AND status = 'PENDING_CONFIRMATION' AND confirmation_deadline > ?`,
            [o.id, now],
          );
          if (pending.length > 0)
            throw new AppError(
              409,
              'RESCHEDULE_PENDING',
              'A replacement request for this booking is already pending',
            );
        }
        await this.expireStale(tx, candidate.assignment.doctor_profile_id, identityId, now);
        const exclude = original === null ? [] : [original.id];
        const date = localTime(candidate.timeZone, startsAt.getTime()).date;
        const mine = await identityBusy(
          tx,
          identityId,
          { from: startsAt.getTime(), to: startsAt.getTime() + candidate.durationMinutes * 60_000 },
          now,
          exclude,
        );
        if (mine.length > 0) throw ERR.patient();
        const slot = (
          await slotsFor(tx, candidate, { from: date, to: date }, now, { excludeIds: exclude })
        ).find((s) => s.startsAt === startsAt.getTime());
        if (slot === undefined) throw ERR.slot();
        const profileId = await this.ensurePatientProfile(tx, input.clinicId, person);
        const deadline = confirmationDeadline(
          now,
          startsAt,
          candidate.settings.confirmationTtlMinutes,
        );
        let id: string;
        try {
          id = String(
            (
              await tx.execute(
                `INSERT INTO bookings (clinic_id, branch_id, mode, status, patient_profile_id, person_id, doctor_profile_id,
                   assignment_id, offering_id, service_id, starts_at, ends_at, block_ends_at, time_zone, confirmation_deadline,
                   actor_kind, actor_user_id, guest_session_id, delegation_id, relationship, contact_phone_e164, patient_note,
                   doctor_display_name, service_name_en, service_name_ar, price_minor, currency, duration_minutes, buffer_minutes,
                   cancellation_policy, booking_rules, reschedule_of_booking_id, status_changed_at, status_changed_by_user_id)
                 VALUES (?, ?, 'SLOT', 'PENDING_CONFIRMATION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  input.clinicId,
                  input.branchId,
                  profileId,
                  person.id,
                  candidate.assignment.doctor_profile_id,
                  candidate.assignment.id,
                  candidate.offeringId,
                  candidate.serviceId,
                  new Date(slot.startsAt),
                  new Date(slot.endsAt),
                  new Date(slot.blockEndsAt),
                  candidate.timeZone,
                  deadline,
                  actor.kind,
                  actor.userId,
                  actor.guestSessionId,
                  actor.delegationId,
                  actor.relationship,
                  actor.contactPhone,
                  input.note ?? null,
                  candidate.assignment.display_name,
                  candidate.serviceNameEn,
                  candidate.serviceNameAr,
                  candidate.priceMinor,
                  candidate.currency,
                  candidate.durationMinutes,
                  candidate.bufferMinutes,
                  JSON.stringify(cancellationPolicyOf(candidate.settings)),
                  JSON.stringify({
                    slotIntervalMinutes: candidate.settings.slotIntervalMinutes,
                    minLeadMinutes: candidate.settings.minLeadMinutes,
                    maxHorizonDays: candidate.settings.maxHorizonDays,
                    confirmationTtlMinutes: candidate.settings.confirmationTtlMinutes,
                  }),
                  rescheduleOf,
                  now,
                  actor.userId,
                ],
              )
            ).insertId,
          );
        } catch (err) {
          // Second line of defence: the unique active keys (doctor/person/replacement).
          if (isDuplicateKey(err)) throw ERR.slot();
          throw err;
        }
        await this.history(
          tx,
          input.clinicId,
          id,
          null,
          'PENDING_CONFIRMATION',
          actor.kind,
          actor.userId,
          null,
        );
        await this.event(
          tx,
          rescheduleOf === null ? 'booking.requested' : 'booking.reschedule_requested',
          id,
          input.clinicId,
          {
            branchId: input.branchId,
            status: 'PENDING_CONFIRMATION',
            startsAt: new Date(slot.startsAt).toISOString(),
            confirmationDeadline: deadline.toISOString(),
            personId: person.id,
            rescheduleOfBookingId: rescheduleOf,
          },
        );
        await this.audit(
          tx,
          AUDIT_ACTION.BOOKING_CREATED,
          actor.userId,
          id,
          input.clinicId,
          {
            actorKind: actor.kind,
            delegationId: actor.delegationId,
            rescheduleOf,
          },
          meta,
        );
        return { status: 201, body: { data: patientView(await this.loadRow(tx, id)) } };
      },
    );
  }

  // =====================================================================================
  // Clinic decisions
  // =====================================================================================

  /**
   * Confirms a pending request after re-validating EVERYTHING inside the transaction: still
   * pending, deadline not passed (an overdue request is expired here — the worker is never
   * needed for correctness), doctor still eligible, offering/service available, time still
   * inside working time, no doctor (global) or patient conflict, and the operation gate (via
   * clinic.bookings.manage = NEW_OPERATION). A replacement atomically supersedes its original.
   */
  async confirm(
    principal: Principal,
    tenant: TenantContext,
    bookingId: string,
    idemKey: string | undefined,
    meta: RequestMeta,
  ) {
    const pre = await this.loadForClinic(tenant, bookingId);
    await authorizeBranch(this.deps, principal, tenant, pre.branchId, 'clinic.bookings.manage');
    const outcome = await this.idempotent(
      idemKey === undefined
        ? null
        : {
            scope: `user:${principal.userId}`,
            operation: `booking.confirm:${bookingId}`,
            key: idemKey,
            payload: {},
          },
      async (tx) => {
        const now = this.deps.clock();
        await this.lockClinicShared(tx, tenant.clinicId);
        const original =
          pre.rescheduleOf === null
            ? null
            : await this.readBooking(tx, pre.rescheduleOf, tenant.clinicId);
        await this.lockDoctors(tx, [
          pre.doctorProfileId,
          ...(original ? [original.doctorProfileId] : []),
        ]);
        const identityId = await lockIdentityOfPerson(tx, pre.personId);
        const [first, second] = [pre.id, ...(original ? [original.id] : [])].sort(
          (a, b) => Number(a) - Number(b),
        );
        await this.lockedBooking(tx, first ?? pre.id, tenant.clinicId);
        if (second !== undefined) await this.lockedBooking(tx, second, tenant.clinicId);
        const b = await this.lockedBooking(tx, pre.id, tenant.clinicId);
        if (b.status === 'EXPIRED') throw ERR.expired(); // e.g. expired lazily by another booking
        BOOKING_LIFECYCLE.assert(b.status, 'CONFIRMED');
        if (b.deadline.getTime() <= now.getTime()) {
          await this.transition(tx, b, 'EXPIRED', 'SYSTEM', null, 'Confirmation deadline passed');
          return { status: 409, body: { expired: true } };
        }
        const candidate = (
          await loadCandidates(tx, this.deps.clock, {
            clinicId: b.clinicId,
            branchId: b.branchId,
            serviceId: b.serviceId,
            assignmentId: b.assignmentId,
          })
        )[0];
        if (candidate === undefined)
          throw new AppError(
            409,
            'BOOKING_NOT_CONFIRMABLE',
            'The doctor or service is no longer available for this booking',
          );
        if (!(await fitsWorkingTime(tx, candidate, b.startsAt, b.blockEndsAt))) throw ERR.slot();
        const exclude = [b.id, ...(original ? [original.id] : [])];
        const window = { from: b.startsAt.getTime(), to: b.blockEndsAt.getTime() };
        if ((await doctorBusy(tx, b.doctorProfileId, window, now, exclude)).length > 0)
          throw ERR.slot();
        if (
          (
            await identityBusy(
              tx,
              identityId,
              { from: b.startsAt.getTime(), to: b.endsAt.getTime() },
              now,
              exclude,
            )
          ).length > 0
        )
          throw ERR.patient();
        if (original !== null) {
          const o = await this.lockedBooking(tx, original.id, tenant.clinicId);
          if (o.status !== 'CONFIRMED')
            throw new ConflictError('The original booking is no longer confirmed');
          await this.transition(tx, b, 'CONFIRMED', 'STAFF', principal.userId, null);
          await this.transition(
            tx,
            o,
            'RESCHEDULED',
            'STAFF',
            principal.userId,
            `Replaced by booking ${b.id}`,
            {
              superseded_by_booking_id: b.id,
            },
          );
        } else {
          await this.transition(tx, b, 'CONFIRMED', 'STAFF', principal.userId, null);
        }
        await this.audit(
          tx,
          AUDIT_ACTION.BOOKING_STATUS_CHANGED,
          principal.userId,
          b.id,
          b.clinicId,
          { from: 'PENDING_CONFIRMATION', to: 'CONFIRMED', rescheduleOf: original?.id ?? null },
          meta,
        );
        return { status: 200, body: { data: clinicView(await this.loadRow(tx, b.id)) } };
      },
    );
    if ((outcome as { expired?: boolean }).expired === true) throw ERR.expired();
    return outcome;
  }

  async reject(
    principal: Principal,
    tenant: TenantContext,
    bookingId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const pre = await this.loadForClinic(tenant, bookingId);
    await authorizeBranch(this.deps, principal, tenant, pre.branchId, 'clinic.bookings.cancel');
    return this.release(
      pre,
      tenant.clinicId,
      'REJECTED',
      'STAFF',
      principal.userId,
      reason,
      meta,
      (b) => {
        if (b.status !== 'PENDING_CONFIRMATION') BOOKING_LIFECYCLE.assert(b.status, 'REJECTED');
      },
      clinicView,
    );
  }

  async cancelByClinic(
    principal: Principal,
    tenant: TenantContext,
    bookingId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    const pre = await this.loadForClinic(tenant, bookingId);
    await authorizeBranch(this.deps, principal, tenant, pre.branchId, 'clinic.bookings.cancel');
    return this.release(
      pre,
      tenant.clinicId,
      'CANCELLED',
      'STAFF',
      principal.userId,
      reason,
      meta,
      (b) => {
        BOOKING_LIFECYCLE.assert(b.status, 'CANCELLED');
      },
      clinicView,
    );
  }

  // =====================================================================================
  // Patient & guest
  // =====================================================================================

  async cancelByPatient(
    principal: Principal,
    bookingId: string,
    reason: string | null,
    meta: RequestMeta,
  ) {
    const pre = await this.loadForPatient(
      principal,
      bookingId,
      meta,
      'patient.bookings.manage_own',
    );
    const acting = await this.deps.persons.actingAs(this.deps.db, principal.userId, pre.personId);
    return this.patientCancel(
      pre,
      acting.kind === 'SELF' ? 'SELF' : 'DELEGATE',
      principal.userId,
      reason,
      meta,
    );
  }

  async cancelByGuest(
    session: GuestSession,
    bookingId: string,
    reason: string | null,
    meta: RequestMeta,
  ) {
    const pre = await this.loadForGuest(session, bookingId);
    return this.patientCancel(pre, 'GUEST', null, reason, meta);
  }

  private async patientCancel(
    pre: BookingRecord,
    kind: ActorKind,
    userId: string | null,
    reason: string | null,
    meta: RequestMeta,
  ) {
    return this.release(
      pre,
      pre.clinicId,
      'CANCELLED',
      kind,
      userId,
      reason,
      meta,
      (b) => {
        BOOKING_LIFECYCLE.assert(b.status, 'CANCELLED');
        const decision = evaluatePatientCancellation({
          status: b.status,
          startsAt: b.startsAt,
          policy: b.policy,
          reason,
          now: this.deps.clock(),
        });
        if (!decision.allowed)
          throw decision.code === 'REASON_REQUIRED'
            ? new AppError(
                400,
                'CANCELLATION_REASON_REQUIRED',
                'A reason is required to cancel this booking',
              )
            : new AppError(
                409,
                'CANCELLATION_NOT_ALLOWED',
                'The cancellation period for this booking has passed',
                {
                  details: { cancelUntil: decision.cancelUntil?.toISOString() },
                },
              );
      },
      patientView,
    );
  }

  async listForPatient(
    principal: Principal,
    filter: { status?: BookingStatus | undefined; limit: number; cursor?: string | undefined },
    meta: RequestMeta,
  ) {
    await this.deps.persons.ensurePatientRole(principal.userId, meta);
    await this.deps.authz.assert(principal, 'patient.bookings.view_own');
    const persons = (await this.deps.persons.bookablePersons(principal.userId, meta)).map(
      (p) => p.personId,
    );
    return this.listByPersons(persons, filter, patientView);
  }

  async getForPatient(principal: Principal, bookingId: string, meta: RequestMeta) {
    const b = await this.loadForPatient(principal, bookingId, meta, 'patient.bookings.view_own');
    return {
      ...patientView(await this.loadRow(this.deps.db, b.id)),
      history: await this.historyOf(b),
    };
  }

  async listForGuest(
    session: GuestSession,
    filter: { status?: BookingStatus | undefined; limit: number; cursor?: string | undefined },
  ) {
    const person = await this.deps.persons.guestOwnPerson(session);
    return this.listByPersons(person === undefined ? [] : [person.id], filter, patientView);
  }

  async getForGuest(session: GuestSession, bookingId: string) {
    const b = await this.loadForGuest(session, bookingId);
    return {
      ...patientView(await this.loadRow(this.deps.db, b.id)),
      history: await this.historyOf(b),
    };
  }

  // =====================================================================================
  // Clinic reads
  // =====================================================================================

  async listForClinic(
    principal: Principal,
    tenant: TenantContext,
    filter: {
      branchId?: string | undefined;
      assignmentId?: string | undefined;
      serviceId?: string | undefined;
      patientProfileId?: string | undefined;
      status?: BookingStatus | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ) {
    let branches: string[] | 'ALL';
    if (filter.branchId !== undefined) {
      await authorizeBranch(this.deps, principal, tenant, filter.branchId, 'clinic.bookings.view');
      branches = [filter.branchId];
    } else {
      const decision = await this.deps.authz.check(principal, 'clinic.bookings.view', { tenant });
      if (decision.allowed) branches = 'ALL';
      else if (decision.reason === 'BRANCH_CONTEXT_REQUIRED') {
        branches = [];
        const covered = [...new Set(tenant.memberships.flatMap((m) => m.branchIds))];
        for (const id of covered) {
          const bt = await branchTenant(this.deps, principal, tenant, id).catch(() => null);
          if (
            bt !== null &&
            (await this.deps.authz.check(principal, 'clinic.bookings.view', { tenant: bt })).allowed
          )
            branches.push(id);
        }
      } else {
        await this.deps.authz.assert(principal, 'clinic.bookings.view', { tenant });
        branches = [];
      }
    }
    if (branches !== 'ALL' && branches.length === 0) return toPage([], filter.limit);
    const twice = <T>(v: T) => [v, v];
    const rows = await this.deps.db.query<Row>(
      `${BOOKING_SELECT}
        WHERE b.clinic_id = ? ${branches === 'ALL' ? '' : `AND b.branch_id IN (${branches.map(() => '?').join(', ')})`}
          AND (? IS NULL OR b.assignment_id = ?) AND (? IS NULL OR b.service_id = ?) AND (? IS NULL OR b.patient_profile_id = ?)
          AND (? IS NULL OR b.status = ?) AND (? IS NULL OR b.starts_at >= ?) AND (? IS NULL OR b.starts_at < ?)
          AND (? IS NULL OR b.id < ?)
        ORDER BY b.id DESC LIMIT ?`,
      [
        tenant.clinicId,
        ...(branches === 'ALL' ? [] : branches),
        ...twice(filter.assignmentId ?? null),
        ...twice(filter.serviceId ?? null),
        ...twice(filter.patientProfileId ?? null),
        ...twice(filter.status ?? null),
        ...twice(filter.from === undefined ? null : new Date(`${filter.from}T00:00:00Z`)),
        ...twice(
          filter.to === undefined
            ? null
            : new Date(Date.parse(`${filter.to}T00:00:00Z`) + 86_400_000),
        ),
        ...twice(filter.cursor ?? null),
        filter.limit + 1,
      ],
    );
    return toPage(rows.map(clinicView), filter.limit);
  }

  async getForClinic(principal: Principal, tenant: TenantContext, bookingId: string) {
    const b = await this.loadForClinic(tenant, bookingId);
    await authorizeBranch(this.deps, principal, tenant, b.branchId, 'clinic.bookings.view');
    return {
      ...clinicView(await this.loadRow(this.deps.db, b.id)),
      history: await this.historyOf(b),
    };
  }

  // =====================================================================================
  // Expiration (worker sweep + lazy)
  // =====================================================================================

  /**
   * Persists EXPIRED for every pending request whose deadline passed. Idempotent: the UPDATE is
   * conditional on still being pending and overdue, so duplicate, retried or concurrent runs
   * (and a racing confirmation) produce exactly one outcome. Correctness never depends on this
   * job: holds stop counting at their deadline (HOLDS_TIME_SQL) and confirmation refuses them.
   */
  async expireOverdue(limit = 500): Promise<number> {
    const now = this.deps.clock();
    const due = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM bookings WHERE status = 'PENDING_CONFIRMATION' AND confirmation_deadline <= ? ORDER BY confirmation_deadline LIMIT ?`,
      [now, limit],
    );
    let expired = 0;
    for (const { id } of due) {
      const done = await this.deps.db.transactionWithRetry(
        async (tx) => {
          const rows = await tx.query<Row>('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [id]);
          if (rows[0] === undefined) return false;
          const b = toRecord(rows[0]);
          if (b.status !== 'PENDING_CONFIRMATION' || b.deadline.getTime() > now.getTime())
            return false;
          await this.transition(tx, b, 'EXPIRED', 'SYSTEM', null, 'Confirmation deadline passed');
          return true;
        },
        { isolation: 'READ COMMITTED' },
      );
      if (done) expired++;
    }
    return expired;
  }

  // =====================================================================================
  // Internals
  // =====================================================================================

  private async idempotent(
    ctx: IdempotencyContext | null,
    fn: (tx: SqlExecutor) => Promise<{ status: number; body: unknown }>,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (
          await this.deps.db.transactionWithRetry(
            async (tx) => {
              const claim = ctx === null ? null : await claimIdempotencyKey(tx, ctx);
              const result = await fn(tx);
              if (result.status < 300) await claim?.complete(result.status, result.body);
              return result;
            },
            { isolation: 'READ COMMITTED' },
          )
        ).body;
      } catch (err) {
        if (err instanceof IdempotentReplay) return err.response.body;
        if (err instanceof IdempotencyRace && attempt === 0) continue;
        throw err;
      }
    }
  }

  /** Validated, eligible candidate for a request (404 / 409 otherwise) incl. the operation gate. */
  private async candidate(
    tx: SqlExecutor,
    input: SlotRequest,
    checkGate: boolean,
  ): Promise<Candidate> {
    const candidates = await loadCandidates(tx, this.deps.clock, input);
    const c = candidates[0];
    if (c === undefined) throw ERR.slot();
    if (!c.settings.slotEnabled)
      throw new AppError(
        409,
        'SLOT_BOOKING_DISABLED',
        'This clinic does not take appointment bookings',
      );
    if (checkGate) {
      const gate = await this.deps.gate.evaluate({
        clinicId: input.clinicId,
        branchId: input.branchId,
        userId: '0',
        category: 'NEW_OPERATION',
      });
      if (!gate.allowed) throw ERR.closed();
    }
    return c;
  }

  private async lockClinicShared(tx: SqlExecutor, clinicId: string) {
    const rows = await tx.query('SELECT id FROM clinics WHERE id = ? FOR SHARE', [clinicId]);
    if (rows.length === 0) throw new NotFoundError('Clinic not found');
  }

  private async lockDoctors(tx: SqlExecutor, ids: readonly string[]) {
    for (const id of [...new Set(ids)].sort((a, b) => Number(a) - Number(b)))
      await tx.query('SELECT id FROM doctor_profiles WHERE id = ? FOR UPDATE', [id]);
  }

  private async assertDelegationActive(tx: SqlExecutor, delegationId: string) {
    const rows = await tx.query(
      `SELECT id FROM booking_delegations WHERE id = ? AND status = 'ACTIVE' FOR SHARE`,
      [delegationId],
    );
    if (rows.length === 0) throw new NotFoundError('Person not found');
  }

  private async readBooking(tx: SqlExecutor, id: string, clinicId: string): Promise<BookingRecord> {
    const rows = await tx.query<Row>('SELECT * FROM bookings WHERE id = ? AND clinic_id = ?', [
      id,
      clinicId,
    ]);
    if (rows[0] === undefined) throw new NotFoundError('Booking not found');
    return toRecord(rows[0]);
  }

  private async lockedBooking(
    tx: SqlExecutor,
    id: string,
    clinicId: string | null,
  ): Promise<BookingRecord> {
    const rows = await tx.query<Row>(
      `SELECT * FROM bookings WHERE id = ? ${clinicId === null ? '' : 'AND clinic_id = ?'} FOR UPDATE`,
      clinicId === null ? [id] : [id, clinicId],
    );
    if (rows[0] === undefined) throw new NotFoundError('Booking not found');
    return toRecord(rows[0]);
  }

  /** Lazy expiration of this doctor's and patient's overdue holds (keeps unique keys free). */
  /** Lazy expiration of this doctor's and this patient identity's overdue holds. */
  private async expireStale(
    tx: SqlExecutor,
    doctorProfileId: string,
    identityId: string,
    now: Date,
  ) {
    const rows = await tx.query<Row>(
      `SELECT * FROM bookings WHERE (doctor_profile_id = ? OR person_id IN (SELECT id FROM booking_persons WHERE identity_id = ?))
          AND status = 'PENDING_CONFIRMATION' AND confirmation_deadline <= ? ORDER BY id FOR UPDATE`,
      [doctorProfileId, identityId, now],
    );
    for (const r of rows)
      await this.transition(
        tx,
        toRecord(r),
        'EXPIRED',
        'SYSTEM',
        null,
        'Confirmation deadline passed',
      );
  }

  /** Shared release path (reject / cancel): only booking rows are locked (see lock order). */
  private async release(
    pre: BookingRecord,
    clinicId: string,
    to: 'REJECTED' | 'CANCELLED',
    kind: ActorKind,
    userId: string | null,
    reason: string | null,
    meta: RequestMeta,
    check: (b: BookingRecord) => void,
    view: (r: Row) => unknown,
  ) {
    return this.deps.db.transactionWithRetry(
      async (tx) => {
        const b = await this.lockedBooking(tx, pre.id, clinicId);
        check(b);
        const replacement =
          b.status === 'CONFIRMED'
            ? (
                await tx.query<Row>(
                  `SELECT * FROM bookings WHERE reschedule_of_booking_id = ? AND status = 'PENDING_CONFIRMATION' FOR UPDATE`,
                  [b.id],
                )
              )[0]
            : undefined;
        await this.transition(tx, b, to, kind, userId, reason);
        if (replacement !== undefined)
          await this.transition(
            tx,
            toRecord(replacement),
            'CANCELLED',
            'SYSTEM',
            null,
            'Original booking cancelled',
          );
        await this.audit(
          tx,
          AUDIT_ACTION.BOOKING_STATUS_CHANGED,
          userId,
          b.id,
          clinicId,
          { from: b.status, to, actorKind: kind, reason },
          meta,
        );
        return { data: view(await this.loadRow(tx, b.id)) };
      },
      { isolation: 'READ COMMITTED' },
    );
  }

  /** The ONLY place a booking status changes: state machine, conditional UPDATE, history, outbox. */
  private async transition(
    tx: SqlExecutor,
    b: BookingRecord,
    to: BookingStatus,
    kind: ActorKind,
    userId: string | null,
    reason: string | null,
    extra: { superseded_by_booking_id?: string } = {},
  ) {
    BOOKING_LIFECYCLE.assert(b.status, to);
    const result = await tx.execute(
      `UPDATE bookings SET status = ?, status_reason = ?, status_changed_at = ?, status_changed_by_user_id = ?
          ${extra.superseded_by_booking_id === undefined ? '' : ', superseded_by_booking_id = ?'}
        WHERE id = ? AND clinic_id = ? AND status = ?`,
      [
        to,
        reason,
        this.deps.clock(),
        userId,
        ...(extra.superseded_by_booking_id === undefined ? [] : [extra.superseded_by_booking_id]),
        b.id,
        b.clinicId,
        b.status,
      ],
    );
    if (result.affectedRows !== 1)
      throw new ConflictError('The booking changed concurrently; retry');
    await this.history(tx, b.clinicId, b.id, b.status, to, kind, userId, reason);
    const replacement = b.rescheduleOf !== null;
    const type =
      to === 'CONFIRMED'
        ? replacement
          ? 'booking.rescheduled'
          : 'booking.confirmed'
        : to === 'REJECTED'
          ? replacement
            ? 'booking.reschedule_rejected'
            : 'booking.rejected'
          : to === 'EXPIRED'
            ? replacement
              ? 'booking.reschedule_expired'
              : 'booking.expired'
            : to === 'CANCELLED'
              ? 'booking.cancelled'
              : to === 'RESCHEDULED'
                ? 'booking.superseded'
                : `booking.${to.toLowerCase()}`;
    await this.event(tx, type, b.id, b.clinicId, {
      branchId: b.branchId,
      status: to,
      previousStatus: b.status,
      startsAt: b.startsAt.toISOString(),
      personId: b.personId,
      rescheduleOfBookingId: b.rescheduleOf,
      actorKind: kind,
    });
  }

  private async history(
    tx: SqlExecutor,
    clinicId: string,
    bookingId: string,
    from: BookingStatus | null,
    to: BookingStatus,
    kind: ActorKind,
    userId: string | null,
    reason: string | null,
  ) {
    await tx.execute(
      `INSERT INTO booking_status_history (clinic_id, booking_id, from_status, to_status, actor_kind, actor_user_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [clinicId, bookingId, from, to, kind, userId, reason, this.deps.clock()],
    );
  }

  /** Outbox event: ids, statuses and times only — never names, notes, services or prices. */
  private async event(
    tx: SqlExecutor,
    type: string,
    bookingId: string,
    clinicId: string,
    payload: Record<string, unknown>,
  ) {
    await this.deps.outbox.record(tx, {
      type,
      aggregateType: 'booking',
      aggregateId: bookingId,
      clinicId,
      payload: { bookingId, ...payload },
    });
  }

  private async audit(
    tx: SqlExecutor,
    action: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
    actor: string | null,
    bookingId: string,
    clinicId: string,
    metadata: Record<string, unknown>,
    meta: RequestMeta,
  ) {
    await this.deps.auditLog.record(
      tx,
      {
        action,
        actorUserId: actor,
        targetType: 'BOOKING',
        targetId: bookingId,
        clinicId,
        metadata,
      },
      meta,
    );
  }

  /** One clinic profile per (clinic, person); an account's existing profile there is linked. */
  private async ensurePatientProfile(
    tx: SqlExecutor,
    clinicId: string,
    person: PersonRow,
  ): Promise<string> {
    const byPerson = await tx.query<{ id: string }>(
      'SELECT id FROM patient_profiles WHERE clinic_id = ? AND person_id = ?',
      [clinicId, person.id],
    );
    if (byPerson[0] !== undefined) return byPerson[0].id;
    if (person.user_id !== null) {
      const byUser = (
        await tx.query<{ id: string; person_id: string | null }>(
          'SELECT id, person_id FROM patient_profiles WHERE clinic_id = ? AND user_id = ? FOR UPDATE',
          [clinicId, person.user_id],
        )
      )[0];
      if (byUser !== undefined) {
        if (byUser.person_id === null)
          await tx.execute(
            'UPDATE patient_profiles SET person_id = ? WHERE id = ? AND clinic_id = ?',
            [person.id, byUser.id, clinicId],
          );
        return byUser.id;
      }
    }
    return String(
      (
        await tx.execute(
          'INSERT INTO patient_profiles (clinic_id, user_id, display_name, person_id) VALUES (?, ?, ?, ?)',
          [clinicId, person.user_id, person.display_name, person.id],
        )
      ).insertId,
    );
  }

  private async loadRow(executor: SqlExecutor, id: string): Promise<Row> {
    const row = (await executor.query<Row>(`${BOOKING_SELECT} WHERE b.id = ?`, [id]))[0];
    if (row === undefined) throw new NotFoundError('Booking not found');
    return row;
  }

  private async loadForClinic(tenant: TenantContext, bookingId: string): Promise<BookingRecord> {
    const rows = await this.deps.db.query<Row>(
      'SELECT * FROM bookings WHERE id = ? AND clinic_id = ?',
      [bookingId, tenant.clinicId],
    );
    if (rows[0] === undefined) throw new NotFoundError('Booking not found');
    return toRecord(rows[0]);
  }

  /** Booking of a person the caller is (or may book for). Anything else is a 404. */
  private async loadForPatient(
    principal: Principal,
    bookingId: string,
    meta: RequestMeta,
    permission: 'patient.bookings.view_own' | 'patient.bookings.manage_own',
  ) {
    await this.deps.persons.ensurePatientRole(principal.userId, meta);
    await this.deps.authz.assert(principal, permission);
    const rows = await this.deps.db.query<Row>('SELECT * FROM bookings WHERE id = ?', [bookingId]);
    if (rows[0] === undefined) throw new NotFoundError('Booking not found');
    const b = toRecord(rows[0]);
    await this.deps.persons.actingAs(this.deps.db, principal.userId, b.personId).catch(() => {
      throw new NotFoundError('Booking not found');
    });
    return b;
  }

  private async loadForGuest(session: GuestSession, bookingId: string): Promise<BookingRecord> {
    const person = await this.deps.persons.guestOwnPerson(session);
    const rows =
      person === undefined
        ? []
        : await this.deps.db.query<Row>('SELECT * FROM bookings WHERE id = ? AND person_id = ?', [
            bookingId,
            person.id,
          ]);
    if (rows[0] === undefined) throw new NotFoundError('Booking not found');
    return toRecord(rows[0]);
  }

  private async listByPersons(
    personIds: readonly string[],
    filter: { status?: BookingStatus | undefined; limit: number; cursor?: string | undefined },
    view: (r: Row) => unknown,
  ) {
    if (personIds.length === 0) return toPage([], filter.limit);
    const rows = await this.deps.db.query<Row>(
      `${BOOKING_SELECT} WHERE b.person_id IN (${personIds.map(() => '?').join(', ')})
          AND (? IS NULL OR b.status = ?) AND (? IS NULL OR b.id < ?) ORDER BY b.id DESC LIMIT ?`,
      [
        ...personIds,
        filter.status ?? null,
        filter.status ?? null,
        filter.cursor ?? null,
        filter.cursor ?? null,
        filter.limit + 1,
      ],
    );
    return toPage(
      rows.map((r) => ({ id: String(r.id), ...(view(r) as object) })),
      filter.limit,
    );
  }

  private async historyOf(b: BookingRecord) {
    const rows = await this.deps.db.query<Row>(
      'SELECT from_status, to_status, actor_kind, reason, created_at FROM booking_status_history WHERE clinic_id = ? AND booking_id = ? ORDER BY id',
      [b.clinicId, b.id],
    );
    return rows.map((r) => ({
      from: (r.from_status as string | null) ?? null,
      to: r.to_status as string,
      actorKind: r.actor_kind as string,
      reason: (r.reason as string | null) ?? null,
      at: (r.created_at as Date).toISOString(),
    }));
  }
}

export { ForbiddenError };
