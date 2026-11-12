import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../../../src/app.js';
import { createContainer, type Container } from '../../../src/container.js';
import { Database } from '../../../src/infrastructure/database/database.js';
import {
  closeRedisClient,
  createRedisClient,
  type Redis,
} from '../../../src/infrastructure/redis/redis.js';
import { MockOtpProvider } from '../../../src/modules/iam/index.js';
import { LocalPrivateStorage } from '../../../src/modules/platform/index.js';
import { silentLogger } from '../../../src/test-support/silent-logger.js';
import { integrationConfig } from './config.js';

export interface TestClock {
  (): Date;
  advance(ms: number): void;
  reset(): void;
}

function createTestClock(): TestClock {
  let offset = 0;
  const clock = (() => new Date(Date.now() + offset)) as TestClock;
  clock.advance = (ms) => {
    offset += ms;
  };
  clock.reset = () => {
    offset = 0;
  };
  return clock;
}

/** Deleted between tests in FK-safe order. Seeded catalog tables (roles, permissions, role_permissions) are kept. */
const DATA_TABLES = [
  // Task 05.2 (support cases ↔ links reference each other: cleared in reset())
  'identity_link_conflicts',
  'booking_identity_links',
  // Task 05 (children before parents; bookings self-references are cleared in reset())
  'idempotency_keys',
  'booking_status_history',
  'bookings',
  'identity_support_cases',
  'guest_claim_codes',
  'guest_booking_sessions',
  'clinic_booking_settings',
  'booking_delegations',
  // Task 04 (children before parents)
  'schedule_exceptions',
  'schedule_periods',
  'schedules',
  'doctor_service_assignments',
  'branch_service_offerings',
  'clinic_services',
  'doctor_branch_assignments',
  // Task 03 (children before parents)
  'domain_events',
  'platform_settings',
  'clinic_subscription_history',
  'clinic_subscriptions',
  'subscription_plan_versions',
  'subscription_plans',
  'clinic_invitation_branches',
  'clinic_invitations',
  'ownership_transfer_documents',
  'clinic_ownership_transfer_history',
  'clinic_ownership_transfers',
  'clinic_closure_actions',
  'clinic_closure_requests',
  'clinic_access_exceptions',
  'clinic_suspensions',
  'clinic_lifecycle_history',
  'clinic_registration_documents',
  'clinic_registration_review_history',
  'clinic_registration_requests',
  'doctor_verification_documents',
  'doctor_verification_history',
  'doctor_specialties',
  'specialties',
  // Task 02
  'refresh_tokens',
  'sessions',
  'otp_challenges',
  'mfa_recovery_codes',
  'mfa_totp_credentials',
  'clinic_membership_branches',
  'clinic_membership_events',
  'clinic_memberships',
  'patient_profiles',
  'booking_persons',
  'booking_identities',
  'doctor_profiles',
  'user_global_roles',
  'user_profiles',
  'security_events',
  'audit_events',
  'clinic_branches',
  'clinics',
  'users',
];

export interface Harness {
  readonly db: Database;
  readonly redis: Redis;
  readonly container: Container;
  readonly otp: MockOtpProvider;
  readonly clock: TestClock;
  readonly http: () => ReturnType<typeof request>;
  reset(): Promise<void>;
  /** Clears OTP resend cooldowns (for tests that log the same user in repeatedly). */
  clearCooldowns(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Real app (real container, MySQL, Redis) with a controllable clock, a mock OTP outbox and a
 * unique Redis key prefix per harness. `trust proxy` is enabled so tests can simulate client IPs
 * with X-Forwarded-For.
 */
export function createHarness(
  options: { env?: Record<string, string>; extraRoutes?: (container: Container) => Router } = {},
): Harness {
  const base = integrationConfig(options.env);
  const config = { ...base, queue: { prefix: `it-${randomUUID().slice(0, 8)}` } };
  const logger = silentLogger();
  const db = Database.fromConfig(config.database);
  const redis = createRedisClient(config.redis, { connectionName: 'it' }, logger);
  const clock = createTestClock();
  const otp = new MockOtpProvider(logger, 'test');
  const storageDir = mkdtempSync(join(tmpdir(), 'medibook-it-storage-'));
  const storage = new LocalPrivateStorage(storageDir, 'test');
  const container = createContainer({
    config,
    db,
    redis,
    logger,
    clock,
    otpProvider: otp,
    storage,
  });
  // Test-only routes (e.g. tenant-isolation probes) are mounted under /api/v1/test, inside the
  // real API router, so they run through the real middleware and the central error handler.
  const apiRouter = Router();
  apiRouter.use(container.apiRouter);
  if (options.extraRoutes !== undefined) apiRouter.use('/test', options.extraRoutes(container));
  const app = createApp({
    logger,
    bodyLimit: '100kb',
    healthChecks: [],
    healthCheckTimeoutMs: 1_000,
    isShuttingDown: () => false,
    apiRouter,
    trustProxy: true,
  });

  return {
    db,
    redis,
    container,
    otp,
    clock,
    http: () => request(app),
    async reset() {
      clock.reset();
      // subscription_plans ↔ subscription_plan_versions reference each other.
      await db.execute('UPDATE subscription_plans SET current_version_id = NULL');
      await db.execute('UPDATE identity_support_cases SET link_id = NULL');
      // bookings reference their original / replacement booking.
      await db.execute(
        'UPDATE bookings SET reschedule_of_booking_id = NULL, superseded_by_booking_id = NULL',
      );
      for (const table of DATA_TABLES) await db.execute(`DELETE FROM ${table}`);
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH',
          `${config.queue.prefix}:*`,
          'COUNT',
          500,
        );
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    },
    async clearCooldowns() {
      const keys = await redis.keys(`${config.queue.prefix}:*:cd:*`);
      if (keys.length > 0) await redis.del(...keys);
    },
    async close() {
      await closeRedisClient(redis);
      await db.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}
