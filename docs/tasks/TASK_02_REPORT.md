# Task 02 report: Identity, authentication, authorization and tenant isolation

| Field  | Value                                                          |
| ------ | -------------------------------------------------------------- |
| Task   | 02: Identity, Authentication, Authorization & Tenant Isolation |
| Date   | 2026-11-11                                                     |
| Status | Implemented; **awaiting review and approval**                  |
| Next   | Task 03 must not start until this task is approved             |

## Summary

Implemented the identity foundation:

- unified accounts with global roles and per-clinic memberships;
- phone-OTP login with rate limiting;
- EdDSA access tokens with live session checks;
- rotating, hash-only refresh tokens with reuse detection;
- session and device management;
- a centralized RBAC and permission authorization service with clinic and branch context;
- tenant isolation enforced by verified per-request context, an unforgeable `ClinicScope`,
  guarded repositories and composite foreign keys;
- mandatory TOTP 2FA for platform permissions;
- security and audit event logs.

Every requested check was run and passed: migrations, lint, typecheck, **114 unit tests**,
**120 integration tests** (including the auth, authorization, tenant-isolation, security and API
suites), build, Docker smoke tests and Task 01 regression checks.

## Pre-implementation inspection

- Task 01 was complete and green. Issuing Task 02 was treated as approval of Task 01.
- **No blockers.** Four small foundation extensions were needed and made (ADR-024): `Retry-After`
  support, a migrator table option (its own tests no longer touch the real `schema_migrations`),
  an `/api/v1` mount plus `trust proxy` in `createApp`, and a database-only config loader for
  the migration CLI.

## Implemented features

| Area             | Implementation                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity model   | `users`, `user_profiles`, `doctor_profiles` (clinic-independent), `patient_profiles` (per clinic), `user_global_roles`, `clinic_memberships` (one row per clinic × user × role, with status, effective dates, branch scope and history) |
| Account status   | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `INACTIVE`. Admin suspend/reactivate with session revocation, security and audit events                                                                                                  |
| OTP auth         | E.164 normalization; 6-digit CSPRNG codes; HMAC storage; 5-minute expiry; attempt limit under row lock; resend cooldown; per-phone and per-IP limits; generic responses; account created on first verified OTP                          |
| OTP provider     | `OtpProvider` interface + dev-only `MockOtpProvider`, blocked in production by config validation **and** constructor guard                                                                                                              |
| Access tokens    | Ed25519 JWT (`jose`) with `sub`, `sid`, `jti`, `iss`, `aud`; 15-minute TTL; `kid` rotation; pluggable key store                                                                                                                         |
| Refresh tokens   | 256-bit random, SHA-256 only, rotation, reuse detection (session revoked), expiry, revocation                                                                                                                                           |
| Sessions         | device id, app type, device name, OS/app version, IP, user agent, last activity, expiry, revocation. List, revoke one, revoke others, logout, logout-all. Same-device re-login replaces the previous session                            |
| Authorization    | Code permission catalog (30 permissions) mirrored in seeded MySQL tables; `AuthorizationService` (platform, clinic and patient scopes; CLINIC/BRANCH levels; ownership helper); `requirePermission` middleware                          |
| Tenant isolation | `TenantContextResolver` + `clinicContext` middleware (`X-Clinic-Id` / remembered session clinic, re-validated per request), `ClinicScope`, `tenantExecutor` SQL guard, ESLint import restriction, 404 for foreign ids                   |
| Memberships      | `MembershipService`: grant, status transitions and branch changes, with escalation rules, history and audit                                                                                                                             |
| 2FA              | TOTP enrollment, confirmation, verification and recovery codes; encrypted secrets; replay protection; rate limit; mandatory for all platform permissions                                                                                |
| Events           | `security_events` (25 event types) and `audit_events`, structured and indexed, without secrets                                                                                                                                          |
| Tooling          | `npm run secrets:generate`, `npm run role:grant/role:revoke` (bootstrap SUPER_ADMIN)                                                                                                                                                    |

## Database tables and relationships

20 forward-only migrations (`20261111140001`–`20261111140020`), one table each (roles,
permissions and role_permissions include their seed data). Full description:
[IDENTITY_SCHEMA.md](../database/IDENTITY_SCHEMA.md).

`users`, `user_profiles`, `clinics`_, `clinic_branches`_, `roles`, `permissions`,
`role_permissions`, `user_global_roles`, `clinic_memberships`, `clinic_membership_branches`,
`clinic_membership_events`, `doctor_profiles`, `patient_profiles`, `otp_challenges`,
`sessions`, `refresh_tokens`, `mfa_totp_credentials`, `mfa_recovery_codes`,
`security_events`, `audit_events`. (*minimal anchors, ADR-021)

Cross-clinic integrity is enforced at the database level: composite FKs `(membership_id, clinic_id)` and
`(clinic_id, branch_id)`; `CHECK role_scope = permission_scope`; global roles limited to
PLATFORM/PATIENT; memberships limited to CLINIC roles.

## API endpoints

All under `/api/v1`: `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh`,
`POST /auth/logout`, `POST /auth/logout-all`, `GET /me`, `GET /me/roles`, `GET /me/memberships`,
`GET /me/permissions`, `GET /me/security-events`, `GET /sessions`, `DELETE /sessions/:id`,
`DELETE /sessions`, `GET /context/clinics`, `POST /context/clinic`, `GET /context/branches`,
`GET /security/mfa`, `POST /security/mfa/totp/enrollment`, `POST /security/mfa/totp/enrollment/confirm`,
`POST /security/mfa/verify`, `POST /security/mfa/recovery-codes`,
`POST /admin/users/:id/suspend`, `POST /admin/users/:id/reactivate`.
Details: [IDENTITY_ARCHITECTURE.md §4](../architecture/IDENTITY_ARCHITECTURE.md).

## Permission mapping (initial, needs business review)

SUPER_ADMIN: all 7 `platform.*` permissions, MFA required, **no implicit clinic access**.
PATIENT: `patient.profile.view_own`, `patient.bookings.view_own`, `patient.bookings.manage_own`.

| Permission                      | Level  | Owner | Manager | Doctor | Receptionist |
| ------------------------------- | ------ | :---: | :-----: | :----: | :----------: |
| `clinic.settings.manage`        | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.memberships.view`       | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.memberships.manage`     | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.branches.manage`        | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.doctors.manage`         | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.services.manage`        | CLINIC |  ✅   |   ✅    |   —    |      —       |
| `clinic.data.export`            | CLINIC |  ✅   |    —    |   —    |      —       |
| `clinic.schedules.manage`       | BRANCH |  ✅   |   ✅    |   —    |      —       |
| `clinic.patients.view`          | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.patients.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.bookings.view`          | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.bookings.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.queue.manage`           | BRANCH |  ✅   |   ✅    |   ✅   |      ✅      |
| `clinic.consultations.start`    | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.view`   | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.create` | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.medical_records.update` | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.prescriptions.manage`   | BRANCH |   —   |    —    |   ✅   |      —       |
| `clinic.payments.manage`        | BRANCH |  ✅   |   ✅    |   —    |      ✅      |
| `clinic.reports.view`           | BRANCH |  ✅   |   ✅    |   —    |      —       |

Role assignment: an owner may manage MANAGER, DOCTOR and RECEPTIONIST; a manager may manage DOCTOR
and RECEPTIONIST. Owners are managed by the platform only, and nobody may change their own
memberships.

## Tenant isolation strategy

Verified per-request clinic context (membership re-read from MySQL every request), `ClinicScope`
required by clinic-scoped repositories, `tenantExecutor` SQL guard, composite FKs, 404 for
cross-tenant ids, and fail-safe errors for missing context. Clinic ids in the body, query or path
are ignored. See [TENANT_ISOLATION.md](../security/TENANT_ISOLATION.md).

## Security decisions

ADR-014 to ADR-024 in [DECISIONS.md](../architecture/decisions/DECISIONS.md). Threats and mitigations:
[THREAT_MODEL.md](../security/THREAT_MODEL.md).

## Commands executed and results

| Command                                                                                                           | Result                                                                                 |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm ci` (clean, after removing all `node_modules` and `dist`)                                                    | ✅                                                                                     |
| Migrations, test DB (vitest global setup + CLI `up`/`status` with `DB_NAME=medibook_test`)                        | ✅ 20 applied, re-run reports 0 pending                                                |
| Migrations, dev DB (`docker compose exec backend npm run migrate` / `migrate:status`)                             | ✅ 20 applied                                                                          |
| `npm run format:check`                                                                                            | ✅                                                                                     |
| `npm run lint`                                                                                                    | ✅ 0 errors / 0 warnings                                                               |
| `npm run typecheck`                                                                                               | ✅                                                                                     |
| `npm test` (unit)                                                                                                 | ✅ 15 files, **114 passed** (Task 01: 63)                                              |
| `npm run test:integration` (all, real MySQL 8.4 + Redis 7.4)                                                      | ✅ 10 files, **120 passed** (Task 01: 14)                                              |
| `npm run test:auth`                                                                                               | ✅ 29 passed                                                                           |
| `npm run test:authorization`                                                                                      | ✅ 26 passed                                                                           |
| `npm run test:tenant` (tenant isolation)                                                                          | ✅ 13 passed                                                                           |
| `npm run test:security`                                                                                           | ✅ 20 passed                                                                           |
| `npm run test:api`                                                                                                | ✅ 11 passed                                                                           |
| Infrastructure suite (Task 01 regression + identity schema), part of the full run                                 | ✅ 21 passed                                                                           |
| `npm run build`                                                                                                   | ✅ all workspaces                                                                      |
| `docker compose config --quiet` (default + `worker` profile)                                                      | ✅ valid                                                                               |
| `docker compose up -d --build backend`                                                                            | ✅ healthy, `/health/ready` reports database up, redis up                              |
| Docker smoke test: OTP request → code from dev log → verify → `/me` → refresh (200) → replay (401) → `role:grant` | ✅                                                                                     |
| Compiled `node dist/server.js` on host                                                                            | ✅ `/health/ready` 200, OTP request 202, graceful shutdown                             |
| `NODE_ENV=production node dist/server.js`                                                                         | ✅ refused: `OTP_PROVIDER: the mock OTP provider is not allowed in production`, exit 1 |
| Worker (`--profile worker`) start + SIGTERM                                                                       | ✅ started, shutdown exit code 0                                                       |
| `npm audit --omit=dev`                                                                                            | ✅ 0 vulnerabilities                                                                   |

### Required test scenarios → where they run

| Requirement                                                                                                                                         | Test file(s)                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Valid/invalid/expired/reused OTP, too many attempts, rate limiting                                                                                  | `auth/otp.test.ts`                                           |
| Refresh rotation, reuse detection, revoked session rejection                                                                                        | `auth/tokens-sessions.test.ts`                               |
| Valid global role, valid/invalid membership, wrong branch, missing permission, suspended account, disabled membership, immediate permission changes | `authorization/authorization.test.ts`                        |
| Cross-clinic read/update/delete, manipulated clinic and resource ids, missing context, concurrent contexts                                          | `tenant-isolation/tenant-isolation.test.ts`                  |
| Token tampering, invalid signature, expired token, refresh replay, OTP brute force, privilege escalation, session revocation                        | `security/security.test.ts` (+ `access-tokens.test.ts` unit) |

### Issues found and fixed during implementation

1. The login flow and `authenticate` used the system time instead of the injected clock. Found in
   review; fixed before the tests ran.
2. The tenant SQL guard rejected legitimate INSERTs. It now requires a `clinic_id` column for
   INSERTs, instead of a workaround in the repository.
3. The `test:auth` path filter also matched `authorization`. Fixed (`tests/integration/auth/`).
4. `/me/permissions` returned clinic permissions in catalog order. They are now sorted, for a
   stable contract.
5. A potentially flaky 2FA test chose a "wrong" code without excluding the ±1-step window. Made
   deterministic.

## Known limitations

- **Production is blocked by design** until a real OTP provider is approved (OD-06).
- Not implemented: 2FA reset/revocation workflow (OD-11), email authentication, account deletion.
- No HTTP endpoints for membership management (service only; belongs to clinic management).
- Strict refresh-token reuse detection logs out clients that refresh in parallel (OD-08).
- Web cookie-based token storage not decided (OD-09).
- Clinic operational/subscription status does not affect access yet (OD-10).
- The PATIENT role is never granted automatically (OD-07).
- No retention/cleanup jobs for OTP challenges, sessions, tokens or events. Log immutability relies
  on convention, not DB grants.
- The SQL tenant guard is a pattern check, not a parser.
- Dev-only `npm audit` advisory (minimatch via ESLint) remains, as in Task 01.
- Each authenticated request adds a few indexed MySQL queries (no caching, by design for immediate
  revocation).

## Deviations and decisions requiring approval

1. **Minimal `clinics` and `clinic_branches` tables** created in the identity migrations as FK
   anchors (ADR-021).
2. **Account auto-creation on the first verified OTP** (ADR-015).
3. **Initial role → permission mapping and role-assignment rules** (ADR-018), notably: no clinical
   permissions for owners, payments for receptionists, owners appointed only by the platform.
4. **CLINIC/BRANCH permission levels**: branch-assigned members must select a branch (ADR-018).
5. **Admin suspend/reactivate endpoints** and **2FA status / recovery-code regeneration endpoints**
   added beyond the listed groups, to make suspension and 2FA usable.
6. **Patient-profile repository and test-only probe routes** used for tenant-isolation testing,
   without patient endpoints.
7. **Task 01 extensions** (ADR-024), with no change to approved behaviour.
8. **Two new dependencies**: `jose`, `libphonenumber-js` (ADR-023).

No Task 03 work was started.
