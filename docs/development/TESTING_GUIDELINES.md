# Testing guidelines

> **Purpose:** test layers, tooling, the integration harness and how to write and run tests.

## Tooling

- **Vitest** for unit and integration tests.
- **Supertest** for HTTP-level tests against `createApp(...)` (no port is opened).

## Test types

| Type        | Location                                      | Command                    | Needs Docker |
| ----------- | --------------------------------------------- | -------------------------- | ------------ |
| Unit        | co-located `src/**/*.test.ts`                 | `npm test`                 | no           |
| Integration | `apps/backend/tests/integration/**/*.test.ts` | `npm run test:integration` | yes          |

Integration suites (each also runnable on its own):

| Folder              | Script                       | Covers                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure/`   | —                            | database, migrator, Redis/BullMQ, identity schema constraints and catalog sync                                                                                                                                                                                   |
| `auth/`             | `npm run test:auth`          | OTP flows and limits, refresh rotation and reuse, sessions                                                                                                                                                                                                       |
| `authorization/`    | `npm run test:authorization` | global and clinic roles, branches, effective dates, immediate effect, escalation rules                                                                                                                                                                           |
| `tenant-isolation/` | `npm run test:tenant`        | cross-clinic read/update/delete, manipulated ids, missing context, concurrency                                                                                                                                                                                   |
| `security/`         | `npm run test:security`      | token tampering and forgery, expiry, replay, brute force, escalation, 2FA                                                                                                                                                                                        |
| `api/`              | `npm run test:api`           | endpoint contracts and envelopes                                                                                                                                                                                                                                 |
| `platform/`         | `npm run test:platform`      | registration, lifecycle, branches + tenant isolation, staff/invitations, ownership transfer, doctor profiles, subscriptions, marketplace (Task 03)                                                                                                               |
| `bookings/`         | `npm run test:bookings`      | availability, creation, guests, delegation, lifecycle, cancellation, rescheduling, conflicts, concurrency, security, guest identity & claims, phone changes, staff bookings, outbox & idempotency, canonical identity links & link conflicts (Task 05/05.1/05.2) |
| `clinic-setup/`     | `npm run test:clinic-setup`  | doctor assignments, services/offerings, branch hours, doctor schedules, DST, cross-branch conflicts, concurrency, security (Task 04)                                                                                                                             |

### Unit tests

- Fast and deterministic: no network, no real database, no real clock where time matters
  (`vi.useFakeTimers()`).
- HTTP behaviour is tested with Supertest on `createApp(...)`, passing fake dependencies
  (e.g. health checks that resolve or reject). `createApp` was designed for this: it opens no
  sockets and creates no connections.
- Use `silentLogger()` from `src/test-support` to keep output clean.

### Integration tests

- Run against the **real** MySQL and Redis from `docker compose up -d`.
- Configuration is read from the environment / `apps/backend/.env` (see
  [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md#5-running-the-backend-on-the-host-optional)).
- They **always** use the dedicated `<DB_NAME>_test` database (`tests/integration/support/config.ts`),
  never the development database. A global setup (`support/global-setup.ts`) applies the real
  migrations to it before the run.
- Identity tests use `support/harness.ts`: the real container and app with a controllable clock
  (`h.clock.advance(ms)`), the mock OTP outbox (`h.otp.lastCodeFor(phone)`), freshly generated
  auth secrets and a unique Redis key prefix. `h.reset()` clears data tables (not the seeded
  catalog) between tests. Fixtures in `support/fixtures.ts` create synthetic users, clinics,
  branches and memberships. Use only the fictional `+1 202 555 01xx` numbers.
- BullMQ tests use a unique random key prefix per run and obliterate their queues afterwards.
- Files run sequentially (`fileParallelism: false`) because they share one database.
- Infrastructure test files create the tables they need and drop them afterwards. Tests must not
  depend on each other's data.
- Every new clinic-scoped resource needs cross-clinic read/update/delete tests (see
  TENANT_ISOLATION.md checklist).

## Rules

1. Every bug fix gets a test that fails without the fix.
2. New infrastructure and every business service get tests. Controllers are covered through
   Supertest route tests.
3. Test behaviour through public APIs, not private internals.
4. **No real patient data**, ever. Use obviously synthetic values (`Test Patient 1`,
   `patient1@example.test`).
5. Don't weaken lint rules for tests beyond the narrow overrides in `eslint.config.js`. Use the
   typed helpers in `src/test-support/http.ts` for Supertest bodies.
6. A test that needs a sleep to pass is a broken test: wait for an event or use fake timers.

## Before pushing

```bash
npm run validate          # format check, lint, typecheck, unit tests, build
npm run test:integration  # with docker compose up
```

## Task 03 helpers

`support/platform.ts`: `adminSession` (MFA-verified Super Admin), `onboardClinic` (full API
registration → approval), `addStaff` (invite + accept), `createPlan`, and **probe routes**
(`/api/v1/test/probe/<permission>`) that run the real authorization chain to prove clinic-state
enforcement for categories whose business endpoints arrive in later tasks. `createClinic` fixtures
include an ACTIVE subscription, because a clinic without one is restricted by design.
