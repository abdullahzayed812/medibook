# Architecture decisions

> **Purpose:** the project's decision log. Every significant architectural or business-rule
> decision is recorded here, with its status and history.

Lightweight ADR log. Each entry: context → decision → consequences/trade-offs.
Status values: **Approved** (from the project blueprint), **Accepted** (made in a task, open to
review), **Open** (needs a decision before the related work starts).

New decisions are appended. Superseded decisions are marked, never deleted.

---

## ADR-001 — Modular monolith, not microservices · Approved

**Decision.** One backend codebase (`apps/backend`) with internal modules
(`src/modules/<name>`) and explicit boundaries (public `index.ts`, table ownership), deployed as
two process types (API and worker).

**Trade-offs.** Simple deployment, local transactions across modules, easy refactoring, and one
database to operate. The cost is that boundaries are enforced by convention and review rather
than by the network. A module can be extracted later if it needs independent scaling, and clean
boundaries keep that option open.

## ADR-002 — Shared MySQL 8 database, strict tenant isolation · Approved

**Decision.** All tenants share one MySQL database. Tenant isolation is enforced in the
application data layer of tenant-scoped modules. MySQL is the source of truth.

**Trade-offs.** Cheapest to operate and simplest to query across tenants for platform features.
The risk is cross-tenant data leaks through a missing filter, so isolation must be enforced
centrally in repositories and covered by tests. See OD-03.

## ADR-003 — Raw SQL, no ORM / query builder · Approved

**Decision.** `mysql2/promise` with parameterized statements behind a thin `Database` class
(`query`, `execute`, `transaction`, `ping`, `close`).

**Trade-offs.** Full control over SQL, locking (`FOR UPDATE`) and performance, with no ORM
magic. The cost is more hand-written mapping code and no compile-time checking of SQL against
the schema. Mitigations: row interfaces per query, integration tests against real MySQL, and
the database coding standards.

## ADR-004 — npm workspaces, not pnpm · Approved

Root `package.json` lists workspaces explicitly in build-dependency order (packages first),
because `npm run <script> --workspaces` runs them in that order.

## ADR-005 — ESM + TypeScript `NodeNext`, compiled with `tsc` · Accepted (Task 01)

**Decision.** `"type": "module"` everywhere. `module`/`moduleResolution: NodeNext`, so
relative imports use the `.js` extension. Production code is compiled with `tsc`. Development
uses `tsx watch`, which needs no build step.

**Trade-offs.** ESM is the Node.js standard going forward and is required by a growing part of
the ecosystem. The `.js` extension in TS imports is slightly unusual. Compiling with `tsc` rather
than a bundler keeps stack traces and output simple.

## ADR-006 — Library choices for backend infrastructure · Accepted (Task 01)

| Concern          | Choice                                                    | Reason                                                                                                                            |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| HTTP             | **Express 5**                                             | Approved Express; v5 is the current major and forwards rejected promises to error middleware, so no async wrapper is needed       |
| Validation       | **zod 4**                                                 | One schema library for env config, request validation and (later) shared client schemas in `packages/validation`; infers TS types |
| Logging          | **pino 10 + pino-http 11**                                | Fast structured JSON logs, built-in redaction, per-request child loggers with correlation ID                                      |
| MySQL driver     | **mysql2 3**                                              | Promise API, prepared statements, pooling; no ORM                                                                                 |
| Redis client     | **ioredis 5**                                             | The client BullMQ 5 is built on (deduped with BullMQ's own dependency)                                                            |
| Queues           | **BullMQ 5**                                              | Approved. v5 chosen over v6 (released 2026-07) to stay on the long-proven line; upgrade is a separate, deliberate task            |
| Dev runner       | **tsx**                                                   | Runs TS directly, with watch mode                                                                                                 |
| Tests            | **Vitest 4.1**                                            | Approved Vitest. **Vitest 5 requires Node ≥ 22**, incompatible with the approved Node 20 LTS                                      |
| TypeScript       | **5.9**                                                   | typescript-eslint 8 supports `<6.1`; TS 7 cannot be linted yet                                                                    |
| Lint             | **ESLint 10 + typescript-eslint 8** (`strictTypeChecked`) | Catches floating promises, unsafe `any` flows and unnecessary conditions                                                          |
| Env file loading | Node's built-in `process.loadEnvFile`                     | No `dotenv` dependency needed on Node ≥ 20.12                                                                                     |

## ADR-007 — Forward-only, checksummed SQL migrations; never automatic on boot · Accepted (Task 01)

**Decision.** A small in-house runner (`src/infrastructure/database/migrations`):

- Files `YYYYMMDDHHMMSS_snake_name.sql` (UTC timestamps avoid number collisions between
  parallel branches).
- `schema_migrations` table records version, name, SHA-256 checksum, duration, timestamp.
- It refuses to run on a checksum mismatch, an applied file missing from disk, or a pending file
  older than the newest applied one.
- A `GET_LOCK` named lock serializes concurrent runs.
- A dedicated connection with `multipleStatements` (the app pool never enables it).
- No down migrations: fix forward.
- Run explicitly (`npm run migrate`), never on application start.

**Trade-offs.** Writing a runner instead of adopting a tool keeps the "raw SQL, no ORM / query
builder" rule literal and adds no dependency. It is under 300 lines, comments included, and tested. Down migrations
are rarely safe on production data, and forward-only keeps history honest. Running migrations
explicitly avoids several replicas racing at boot and keeps deploys predictable. **MySQL DDL is
not transactional**, so a failed multi-statement migration may be partially applied. That is why
the standards say one logical change per file.

_Amended by ADR-036 (Task 03.1):_ the runner is unchanged. Before the first Production release,
unreleased migrations that have been applied only to disposable databases may be amended and
the databases rebuilt.

## ADR-008 — Separate worker process; MySQL is the source of truth · Approved/Accepted

**Decision.** `src/worker.ts` is a separate entry point. Job definitions are registered in
`src/jobs/registry.ts` (empty in Task 01). Workers use a Redis connection with
`maxRetriesPerRequest: null` (required by BullMQ). The Compose Redis runs with
`maxmemory-policy noeviction` (evicted keys would silently lose jobs). Job data carries IDs, and
processors must be idempotent.

## ADR-009 — Health: liveness vs readiness · Accepted (Task 01)

`GET /health` (liveness: no dependency checks; used by the Docker healthcheck so a database
blip doesn't mark the container unhealthy) and `GET /health/ready` (MySQL and Redis with
per-check timeout; 503 while shutting down so load balancers drain traffic first).

## ADR-010 — Correlation IDs via `X-Request-Id` · Accepted (Task 01)

Reuse a well-formed incoming `X-Request-Id` (≤128 chars of `[A-Za-z0-9._:-]`, to prevent log
injection), otherwise generate a UUID v4. Echo it in the response header, attach it to every log
line (`req.id`), and include it in error bodies. Propagating the ID into service-layer and job
logs without passing loggers around (e.g. via `AsyncLocalStorage`) is deferred until a module
needs it.

## ADR-011 — Configuration: validated env vars, fail fast, no secrets in the repo · Accepted (Task 01)

All config is read once, validated with zod and deep-frozen. Missing or invalid values abort
startup and name the variables without printing their values. Empty strings count as unset.
Compose uses `${VAR:?}` for every credential, so it refuses to start without a filled-in `.env`.
`.env.example` files contain empty placeholders only. Host ports bind to `127.0.0.1`.

## ADR-012 — Integration tests use a dedicated `<DB_NAME>_test` database · Accepted (Task 01)

Created by `infrastructure/mysql/init/01-create-test-database.sh` on first volume init. The test
helper always appends `_test`, so integration tests cannot touch development data.

## ADR-013 — Docker Compose layout · Accepted (Task 01)

`docker-compose.yml` at the repository root (so `docker compose` works with no flags).
Dockerfiles and DB init scripts live in `infrastructure/`. Images: `node:20.19-bookworm-slim`,
`mysql:8.4` (8.x LTS), `redis:7.4-alpine`. The dev image installs only the backend workspace's
dependencies and bind-mounts `src/` for hot reload. `init: true` ensures SIGTERM reaches Node.
The **worker** service is opt-in via the `worker` profile.

## ADR-014: Unified account; roles split into global roles and clinic memberships · Accepted (Task 02)

One `users` row per person (login = verified phone). Global roles (`SUPER_ADMIN`, `PATIENT`) are
in `user_global_roles`. Clinic roles are in `clinic_memberships`, **one row per clinic × user ×
role**, so a person can be owner and doctor in the same clinic. Doctor profiles are
clinic-independent; patient profiles are per clinic (no central medical record). Database CHECKs
and composite `(code, scope)` FKs make it impossible to mix the two kinds of role.
_Trade-off:_ several rows per person per clinic, but each has its own status, dates, branches and
history.

## ADR-015: Phone OTP "sign in or sign up"; account created on first verified OTP · Accepted, **needs approval** (Task 02)

The OTP request never touches `users` (no enumeration). A correct OTP proves phone ownership, so
the account is created then (status `ACTIVE`). `PENDING_VERIFICATION` is for accounts created by
others (future invitations) and becomes `ACTIVE` on first OTP. `SUSPENDED`/`INACTIVE` accounts
are refused after a correct OTP. _Alternative not chosen:_ login only for pre-existing accounts.
That would require a separate registration flow and leaks existence unless carefully designed.

## ADR-016: Access tokens = EdDSA JWT with identity only; state re-read per request · Accepted (Task 02)

Short-lived (15 min) Ed25519 JWTs (`jose`) carry `sub`, `sid`, `jti`, `iss`, `aud`. Every
request loads session and account status from MySQL, and authorization reads memberships and
`role_permissions` live. _Trade-off:_ about 2–4 small indexed queries per authenticated request.
In return, revocation, suspension and permission changes apply immediately. A Redis cache can be
added later with explicit invalidation if needed. Keys come from an `AccessTokenKeyStore`
(env-backed today, KMS/secrets-manager later), with `kid`-based rotation.

## ADR-017: Opaque rotating refresh tokens, hash-only, strict reuse detection · Accepted (Task 02)

256-bit random tokens, SHA-256 stored, rotated on every use, family = session. Reuse of a rotated
token revokes the session. No grace window (security over convenience; see OD-08).

## ADR-018: Authorization = permission catalog in code, mapping in MySQL, one service · Accepted (Task 02)

`catalog.ts` is the reviewable definition. Seed migrations mirror it, and an integration test
enforces equality. `role_permissions` is read at runtime so changes take effect immediately. All
decisions go through `AuthorizationService` / `requirePermission`. Clinic permissions have a
**level**: CLINIC-level needs `branch_scope = ALL`; BRANCH-level needs ALL or an assignment to the
selected branch; branch-assigned members without a selected branch are refused (fail safe). The
initial role → permission mapping and the role-assignment rules (AUTHORIZATION.md) **need
business review**, notably: owners have no clinical permissions, receptionists manage payments,
and owners cannot appoint owners.

## ADR-019: Tenant isolation via verified context + `ClinicScope` + guarded repositories · Accepted (Task 02, resolves OD-03)

Clinic context comes from `X-Clinic-Id` (or the session's remembered clinic) and is accepted only
after verifying an active membership per request. Clinic-scoped repositories take a `ClinicScope`
(private constructor; factory import restricted by ESLint) and run SQL through `tenantExecutor`,
which rejects statements lacking a `clinic_id = ?` filter bound to the scope. Composite FKs carry
`clinic_id`. Cross-tenant ids return 404. Sequential numeric ids are kept (simpler raw SQL, good
InnoDB locality). Authorization and 404 semantics, not id secrecy, protect resources.

## ADR-020: Mandatory TOTP for platform permissions, per-session MFA state · Accepted (Task 02)

TOTP (RFC 6238) on `node:crypto`; secret AES-256-GCM encrypted; recovery codes HMAC-hashed;
replay protection via last accepted step. Every PLATFORM permission requires an MFA-verified
session; there is no bypass. Enrollment revokes the user's other sessions. 2FA reset/revocation
workflows are not implemented (see AUTHENTICATION.md §4).

## ADR-021: Minimal `clinics` / `clinic_branches` anchor tables in the identity migrations · Accepted, **needs approval** (Task 02)

Memberships and branch assignments need FK targets before the clinic-management module exists.
Only `id`, `clinic_id` (branches) and `name` are created. Operational status, subscription
status and all other clinic fields are added by the clinic task through new migrations. Until
then, **clinic operational/subscription status does not affect authorization** (OD-10).

## ADR-022: Security events vs audit events · Accepted (Task 02)

`security_events`: authentication and session facts (OTP, login, refresh, reuse, logout, 2FA,
context switch), including for not-yet-identified users (keyed phone hash). `audit_events`:
privileged changes (account status, memberships, roles, 2FA enrollment) with actor and target,
written in the same transaction as the change. Both are append-only, have no FKs, and never
contain OTPs, tokens, secrets or medical data.

## ADR-023: New dependencies `jose` and `libphonenumber-js` · Accepted (Task 02)

`jose` 6 (zero-dependency JOSE/JWT, EdDSA support) and `libphonenumber-js` 1.x (`/max`
metadata) for E.164 normalization and validation. TOTP, base32, HKDF, HMAC and AES-GCM use
`node:crypto` (no extra packages).

## ADR-024: Small Task 01 extensions required by Task 02 · Accepted (Task 02)

No rewrite. Extensions only: `TooManyRequestsError` + `Retry-After` in the error handler; a
`Migrator` `table` option (the migrator's own tests no longer touch the real
`schema_migrations`); `createApp` accepts `apiRouter` (mounted at `/api/v1`) and `trustProxy`;
`loadDatabaseConfig` so the migration CLI does not need API secrets; extra log redaction paths;
integration tests reorganized into folders, with a global setup that migrates the test database.

## ADR-025: Clinic state enforced centrally through permission categories + operation gate · Accepted (Task 03)

Each clinic permission carries an operation category. `AuthorizationService` calls an injected
`ClinicOperationGate` after a membership grants a permission. Suspension, closure, subscription
and inactive-branch rules therefore apply to every endpoint that uses the standard authorization
path, future modules included. This is the smallest change to the Task 02 architecture that
meets "enforcement must be centralized". _Trade-off:_ about 3–4 extra indexed queries per
clinic permission check; no caching, so changes take effect immediately.

## ADR-026: Operating policy matrix · Accepted (Task 03; verified and clarified in Task 03.2)

The matrix in [CLINIC_LIFECYCLE.md](../../platform/CLINIC_LIFECYCLE.md#operating-policy-central-operation-policyts),
implemented once in `evaluateClinicOperation` (`clinics/operation-policy.ts`) and applied by
`ClinicOperationGate` inside `AuthorizationService.check`, after the membership and role check,
for every clinic permission. Notable choices:

- a **NEW_OPERATIONS** suspension blocks only NEW_OPERATION; reads, continuity of care,
  administration and lifecycle stay available;
- a **FULL** suspension blocks READ, CONTINUITY_OF_CARE, ADMINISTRATION and NEW_OPERATION. Only
  CLINIC_INFO and LIFECYCLE stay available. READ and CONTINUITY_OF_CARE can be restored per user
  through a Super-Admin **access exception**: `platform.clinics.manage` with MFA, never to
  oneself, only for an active member, only during a FULL suspension, bound to that suspension,
  time-limited (≤ 72 h by default), revocable, audited on grant and revoke;
- CLOSING blocks NEW_OPERATION; CLOSED keeps READ only (record retention);
- a restricted subscription blocks only NEW_OPERATION and growth actions;
- an inactive selected branch blocks NEW_OPERATION at that branch;
- rules combine and the most restrictive applies.

Registration, operational and subscription status stay independent (ADR-027): a suspension
changes neither the subscription nor the registration.

_Task 03.2 verification:_ the code, unit matrix, integration tests and documentation agree on
every cell. One defect was fixed: an access exception could be self-granted by a Super Admin
who is also a member of the clinic. Newly tested: revocation, exceptions bound to their
suspension, NEW_OPERATIONS keeping administration, and status independence.

## ADR-027: Registration `SUSPENDED` = review frozen · Accepted (Task 03; confirmed in Task 03.1)

The specification lists SUSPENDED among registration statuses without defining it. It is
modelled as a reviewer freezing a pending review (reachable from PENDING_REVIEW, UNDER_REVIEW
and NEEDS_INFORMATION; it leads to UNDER_REVIEW or REJECTED). An approved clinic's suspension is
the separate operational status.

_Task 03.1 clarification:_ registration status, clinic operational status and subscription
status are three independent dimensions, stored separately and changed by separate workflows.
The only cross-effects are approval (which initializes the other two) and closure completion
(which expires the subscription). While SUSPENDED, applicant edits, submission, approval and
information requests are blocked. Only resume and reject, each with a reason, are allowed.
Transitions and affected operations:
[CLINIC_REGISTRATION.md](../../platform/CLINIC_REGISTRATION.md#registration-suspended-adr-027-confirmed-in-task-031).

## ADR-028: Approval creates clinic + main branch + owner membership + subscription atomically · Accepted (Task 03; confirmed in Task 03.1)

A clinic row exists only after approval. The main branch copies the registration address
(time zone UTC, editable). The approving admin selects the plan. A plan without trial days
creates a PAST_DUE subscription (payment due now; grace applies).

_Task 03.1 confirmation:_ approval is a single database transaction behind a row lock on the
request, with no external side effects. Any failure rolls back every row and leaves the request
UNDER_REVIEW. A retry is a plain re-approval, and a second or concurrent approval gets
`409 INVALID_TRANSITION`, so partial activation and double creation are both impossible. Tested
in `registration.test.ts`. The trial-less-plan branch (PAST_DUE instead of TRIAL) is recorded
as ADR-038 (Task 03.2).

## ADR-029: Subscriptions: immutable plan versions; stored status + date-derived effective status · Accepted (Task 03)

Plan versions are never edited. Enforcement always uses `effectiveSubscription(...)`, so the
15-minute sweep (BullMQ job scheduler) only keeps the stored status and history accurate and
never extends access. A clinic without a subscription is restricted (fail safe). Money is
stored as integer minor units. The billing seam is `recordPayment` plus `subscription.*`
outbox events.

## ADR-030: Invitations are the only clinic-side way to add members · Accepted (Task 03)

Invitations are phone-bound, single-use and expiring, store only a token hash, and can never
target CLINIC_OWNER. The inviter's authority is re-checked at acceptance. The token is returned
once to the inviter until a notification provider exists. Direct grants stay platform-only.

## ADR-031: Ownership transfer removes ALL of the previous owner's roles in that clinic · Accepted (Task 03; confirmed in Task 03.1)

This is the reading of "may remain only if the new owner grants an appropriate role". Initiation
counts as the current owner's explicit approval. A TRANSFER_AGREEMENT document and recorded
identity verification are required before approval.

_Task 03.1 confirmation:_ the previous owner's account, global roles, sessions, MFA, doctor
profile and memberships in other clinics are never touched. The new owner may later grant them
a new non-owner role through the normal invitation workflow. Tested in
`ownership-transfer.test.ts`.

## ADR-032: Private documents via `PrivateObjectStorage`; dev-only local provider · Accepted (Task 03)

No private storage existed (R2 is a future integration). The interface plus a local-disk
provider is the smallest safe adjustment. The local provider is refused in production
(`PRIVATE_STORAGE_PROVIDER`), so **production also needs the R2 integration** (OD-13).
Uploads use raw request bodies (no multipart dependency), with magic-byte checks.

## ADR-033: Transactional outbox `domain_events` · Accepted (Task 03; resolves OD-04 for writes)

Integration events are written in the same transaction as the change. The publisher (worker)
and its consumers are later tasks.

## ADR-034: Last-active-owner guard and per-clinic serialization · Accepted (Task 03)

Every membership change, transfer completion and branch-limit check locks the clinic row
first (consistent lock order). The last ACTIVE owner cannot be removed except through a
transfer. Concurrency tests cover mutual owner removal and parallel transfer approval.

_Task 03.2:_ invitation acceptance used to lock the invitation row before the clinic row, the
reverse of closure approval (clinic, then pending invitations), which could deadlock. It now
locks the clinic first and re-reads the invitation. Tested with parallel acceptances and an
acceptance racing a closure approval.

## ADR-035: Separate `platform.specialties.manage` for the specialty catalog · Accepted (Task 03.1)

Task 03 guarded specialty catalog changes with `platform.doctors.verify`. Reviewing doctors and
curating a reference catalog are different duties, and a future reviewer-only role would
otherwise inherit catalog control. `platform.specialties.manage` (PLATFORM, SUPER_ADMIN only)
now guards `PUT /admin/specialties/:code` (create, rename, deactivate).
`platform.doctors.verify` still guards every review and decision endpoint. SUPER_ADMIN holds
both, so existing behaviour is unchanged. Both directions are tested (unit and API).

## ADR-036: Migration policy: development-phase consolidation, production immutability · Accepted (Task 03.1)

Before the first Production release, unreleased migrations may be amended or consolidated, but
only when every database that applied them is disposable (local dev/test). Those databases are
then rebuilt and validated. Shared or persistent databases always get new forward-only
migrations. After the first Production release, released migrations are immutable, destructive
changes need review, backup and a recovery plan, and automatic schema synchronization is never
used. The runner (ADR-007) is unchanged: its checksum check is what forces the rebuild. Full
policy and procedures:
[DATABASE_MIGRATIONS.md](../../development/DATABASE_MIGRATIONS.md).

## ADR-037: Documentation organized by domain · Accepted (Task 03.1)

Documentation lives under `docs/<category>/` (architecture, development, security, platform,
api, database, operations, tasks, product), with [docs/README.md](../../README.md) as the
index. ADRs moved from `docs/decisions/` to `docs/architecture/decisions/`, and their numbers
are unchanged. New documents go into the matching category, never directly under `docs/`.

## ADR-038: A plan with zero trial days starts PAST_DUE at approval; grace applies; payment activates · Accepted (Task 03.2; product decision, owner to confirm)

Confirms existing behaviour (ADR-028) as an explicit product decision. Resolves OD-19. A zero-trial
plan means "payment is due now". The subscription is created PAST_DUE with `past_due_since` =
approval, no trial and no paid period. The standard grace period (default 3 days, configurable
per clinic, can be 0) is the only unpaid window. Afterwards the effective status is SUSPENDED
(new operations, growth and Marketplace blocked; reads, care, administration and lifecycle
remain). A Super Admin activates the subscription by recording the payment. No path grants
operations without either a running trial, a paid period, or that bounded grace. _Alternative not
chosen:_ treating zero trial days as "blocked until paid" would need a special case in
`effectiveSubscription`. Use a per-clinic grace of 0 for that outcome instead. Details:
[SUBSCRIPTION_MANAGEMENT.md](../../platform/SUBSCRIPTION_MANAGEMENT.md#plans-with-zero-trial-days-adr-038).

## ADR-039: Re-granting a membership starts a new period on the same row · Accepted (Task 03.2)

The unique `(clinic_id, user_id, role_code)` row is reused, as before, so there is no parallel
membership model and no migration. Every re-grant (invitation acceptance, re-hire
TERMINATED → ACTIVE, ownership transfer to a former owner) now resets the effective window to
open-ended and `activated_at` to now (`MembershipsRepository.reactivateAsNewPeriod`). Before,
`updateStatus` kept the old window, so a re-granted membership could be ACTIVE but never
effective. The previous period is written to the audit event (`previousPeriod`) in the same
transaction, and `clinic_membership_events` keeps every transition. Resuming a SUSPENDED or
INACTIVE membership keeps its window (same period). _Trade-off:_ the previous period's window
lives in audit metadata rather than in a dedicated periods table. That is enough for audit,
and a schema change can come later if periods need querying. Details:
[CLINIC_MEMBERSHIPS.md](../../platform/CLINIC_MEMBERSHIPS.md#membership-periods-and-re-granting-adr-039-task-032).

## ADR-040: Clinic setup model: assignment ≠ membership coverage; explicit doctor services; computed effectiveness · Accepted (Task 04)

A doctor's work at a branch is a separate `doctor_branch_assignments` row. Membership branch
scope stays **access**, and an assignment requires coverage but is not implied by it.
Eligibility (active DOCTOR membership covering the branch, VERIFIED and ACTIVE profile) is
checked in the transaction. On every read it is **recomputed**
(`effective` + `blockers`) instead of being cascaded, so membership, verification and
assignment statuses stay independent. Deactivating an assignment ends its schedules and
service assignments in the same transaction, and nothing is deleted. Services are
clinic-defined (EN/AR), with an optional platform-specialty link and no mandatory global
catalog. Branch offerings hold price (integer minor units + ISO 4217, default currency setting
`clinic.default_currency` = EGP), duration and buffer. Doctor ↔ service eligibility is explicit
per branch and pinned by composite FKs to the same clinic and branch, with optional per-doctor
overrides. Writes reuse `clinic.doctors.manage`, `clinic.services.manage` and
`clinic.schedules.manage`. Path branch ids are re-resolved through `TenantContextResolver`, so
branch-assigned staff act only on covered branches (404 otherwise).

## ADR-041: Schedules = immutable dated versions of local wall-clock periods; one DST rule; same-clinic conflicts · Accepted (Task 04)

Branch hours and doctor schedules share `schedules` / `schedule_periods` / `schedule_exceptions`.
A version has an inclusive local date range. A change is a revision (the old version ends the
day before, or is superseded), so periods are never edited and history is reconstructable.
Periods are local minutes in the branch's IANA zone and never cross midnight (overnight = two
periods). Date exceptions are CLOSED, UNAVAILABLE and EXTRA, resolved as
`(weekly − breaks − UNAVAILABLE) ∪ EXTRA`, with CLOSED = nothing. Doctor time must lie in branch
weekly time (both directions enforced). Branch date exceptions resolve by intersection.
Conversion uses `Intl` only. **DST rule:** local time _w_ maps to the first instant the local
clock reads ≥ _w_. Nonexistent times clip to the transition, ambiguous times take the first
occurrence, and nothing is shifted to an unintended wall time. Cross-branch conflicts are
computed in real UTC time with each branch's zone over a 371-day horizon, **within the same
clinic only**: another clinic's schedules are not visible to this clinic and must not block it
(OD-21). All writes lock the clinic row first and validate inside the transaction.
_Trade-off:_ per-clinic serialization of setup writes (rare, admin-only) in exchange for simple,
deadlock-free correctness.

## ADR-042: Two read permissions: `clinic.services.view`, `clinic.schedules.view` · Accepted (Task 04)

No existing permission covered reading configuration. `clinic.services.view` is MEMBER level
(clinic-wide catalog; branch offerings still need branch coverage). `clinic.schedules.view` is
BRANCH level. Both are CLINIC_INFO, so they stay readable in every operating state, and both
are granted to owner, manager, doctor and receptionist (receptionists will book against them,
and doctors see their branches' schedules). Configuration writes are ADMINISTRATION: blocked by
a FULL suspension and closure, but not by a NEW_OPERATIONS suspension or a restricted
subscription (ADR-026).

## ADR-043: A branch time zone is locked while schedules or exceptions are active · Accepted (Task 04)

Recurring times are wall-clock values of the branch zone, so changing the zone would silently
move every period in real time and bypass the cross-branch conflict checks.
`PATCH /clinic/branches/:id` with a different `timeZone` returns `409 BRANCH_TIME_ZONE_LOCKED`
while the branch has an ACTIVE schedule or exception. This adds a guard to existing behaviour;
before Task 04 no schedules existed.

## ADR-044: Availability is computed per request, never stored · Accepted (Task 05)

Slots are derived on every request from Task 04 working time (`schedule-data.workingTime`, the
same resolver as `GET …/working-time`), the offering's duration and buffer (or a per-doctor
duration override), clinic booking settings (interval, lead, horizon) and persisted holding
bookings. Nothing about future slots is persisted or cached, so there is no stale second source
of truth. Booking creation re-runs the computation inside its transaction and requires an exact
slot match. Slots whose real UTC length differs from the service duration (a DST gap or
overlap) are not offered. _Trade-off:_ per-request computation cost, bounded by a 14-day range
and 2,000 slots.

## ADR-045: Global booking persons and BOOKING-only delegations; PATIENT role on first use · Accepted (Task 05; resolves OD-07; **amended by ADR-050**)

The patient conflict key and booking ownership need an identity across clinics, but medical
records must stay clinic-scoped and never merge. `booking_persons` is that global,
non-medical identity: SELF (an OTP-verified phone hash, optionally linked to the account with
that phone) or DEPENDENT. Clinic `patient_profiles` link to it, one per person per clinic.
Delegations authorize booking only: DECLARED for dependents (GUARDIAN only for minors,
otherwise a recorded authority statement) or CONSENT from the person's own account. Guests
verify their phone with a purpose-bound OTP (`GUEST_BOOKING`) and get a short-lived token; no
account is created. An account later owns the same SELF person through its verified phone.
Nothing is ever matched on an unverified phone. The global PATIENT role is granted
automatically, and audited, on first patient booking use.

## ADR-046: Booking concurrency: READ COMMITTED, fixed lock order, global doctor/person locks, in-transaction idempotency · Accepted (Task 05)

Booking writes use READ COMMITTED (no gap locks, latest committed data after locking) and a
bounded deadlock retry (`Database.transactionWithRetry`). Lock order: idempotency key →
clinic `FOR SHARE` (against setup writes) → doctor profile(s) `FOR UPDATE` (global across
clinics) → booking person `FOR UPDATE` → booking rows. Release operations lock only booking
rows. Unique keys on generated `active_key` columns are the second line. Idempotency rows are
written inside the business transaction, so a failure leaves no key, a concurrent duplicate
replays, and a different payload conflicts. _Trade-off:_ one doctor's bookings serialize
globally (short transactions), in exchange for provably no cross-clinic double booking.

## ADR-047: Holds end at the deadline by definition; worker sweep only persists · Accepted (Task 05)

A pending request holds time only while `confirmation_deadline > now`. This is part of every
conflict query, so no worker outage can extend a hold, and confirmation refuses (and records)
overdue requests. The BullMQ sweep (every 30 s) and lazy expiration persist EXPIRED with
history and events, through conditional updates that are idempotent under duplicates and races.
Cancellation policy and booking rules are snapshotted on each booking. Clinic settings change
only future bookings, within platform limits enforced by the schema and DB CHECKs.

## ADR-048: Rescheduling by replacement; queue mode behind a fixed contract · Accepted (Task 05)

A reschedule is a new PENDING booking referencing the CONFIRMED original. Only one pending
replacement is allowed per original. The original keeps its time until the replacement is
confirmed, and then both change in one transaction (`RESCHEDULED` + `superseded_by`). A
rejected or expired replacement leaves the original untouched. Queue bookings reuse the
booking row, status machine, persons, delegation, idempotency, confirmation, expiration and
cancellation. Task 06 adds queue sessions and a `QueueCapacityPort`. Until then, queue
requests and enabling queue mode get 422.

## ADR-049: Fixes to pre-existing login/OTP deadlocks found by Task 05 concurrency tests · Accepted (Task 05)

Concurrent OTP requests for different phones (19 of 24 failed) and concurrent first logins of
different users deadlocked at REPEATABLE READ (gap locks) and returned 500. Both transactions
now run at READ COMMITTED with bounded deadlock retry. They use locking reads, and an OTP
challenge is single-use, so the change is safe. Regression tests were added to
`auth/otp.test.ts`.

## ADR-050: Booking ownership is proven by claim codes, never by phone numbers · Accepted (Task 05.1; amends ADR-045)

Task 05 identified a guest's person by the verified phone, and auto-linked it to the account
with that phone. Phone numbers are recycled, so that let a new owner of a number inherit the
previous owner's bookings. Now:

- the phone hash is not unique and not an identity key;
- SELF persons are keyed by `user_id`;
- GUEST persons belong to the guest session that created them, and their ownership is proven
  only by a 256-bit claim code (shown once; SHA-256 stored; 365 days; revocable by rotation;
  consumed by an account claim);
- a returning guest re-attaches with the code and the same verified phone;
- a claim makes the account the owner (`claimed_by_user_id`), never a merge;
- bookings without a code go to a support case decided by a Super Admin
  (`platform.identity.resolve`, MFA, never the requester).

Clinic profiles are never re-linked. _Trade-off:_ a lost code needs support, and the same human
can end up with two persons (claimed guest plus own); patient-conflict checks treat them
separately (OD-30).

## ADR-051: Verified phone change needs both phones; identity stays the account · Accepted (Task 05.1)

`PHONE_CHANGE` OTPs go to the current and the new phone. The new number must be free. Bookings,
persons and delegations stay with the account, the old number becomes free, and nobody inherits
anything through it. A user who lost the current phone goes through support.

## ADR-052: Staff-created bookings reuse the engine; clinic-recorded persons are never phone-matched · Accepted (Task 05.1; resolves OD-25)

`POST /clinic/bookings` uses `clinic.bookings.manage` for the branch and the same `create()`
path: locks, conflicts, gate, deadline, snapshots and idempotency. The result is a PENDING
request. The beneficiary is an existing profile of the clinic, or a new CLINIC person created in
the booking transaction. The staff user is recorded as the actor. There are no delegations, no
medical access and no phone matching.

## ADR-053: Outbox atomicity verified; idempotency keys become tombstones, never deleted · Accepted (Task 05.1)

Booking changes, history, audit and outbox events share one transaction (verified by fault
injection). Idempotent responses replay for 7 days. Retention then drops the body and sets
`expired_at` but keeps the row, so an old key is refused (`IDEMPOTENCY_KEY_EXPIRED`) instead of
re-executing. Publisher and consumer responsibilities are in BOOKINGS.md § Events.

## ADR-054: Versioned phone-hash keys; rotation cannot orphan identities · Accepted (Task 05.1)

Every stored phone hash carries `phone_hash_key_version`. Because hashes no longer decide
ownership (ADR-050), rotation is safe: add version N+1, write new hashes with it, compare
against all active versions, re-hash lazily on verified contact, and retire N when unreferenced.
The procedure is in BOOKING_PERSONS.md.

## ADR-055: One canonical booking identity per verified human, separate from person records and medical identity · Accepted (Task 05.2; resolves OD-30)

A human could hold several `booking_persons` rows: an account SELF person, guest persons
(claimed or not) and clinic-recorded CLINIC persons. Each was its own patient-conflict key, so one
human could hold overlapping appointments in different clinics. Now:

- **`booking_identities`** is the conflict key. Every person row has a mutable `identity_id` and
  an immutable `origin_identity_id` (its own identity at creation). The patient conflict check
  (availability, creation, confirmation and rescheduling) covers every holding booking of every
  person in the identity, across all clinics.
- **Person records are never merged.** Bookings keep their `person_id`, profile, actor and
  history. Linking only moves a person's `identity_id`, and records an append-only
  `booking_identity_links` row with its source and evidence.
- **Links come only from proof:** a claim code (`CLAIM_CODE`), an audited support decision with a
  recorded evidence type (`SUPPORT_CASE`), or the backfill of earlier claim-code claims
  (`MIGRATION_CLAIM`). Phone equality never links.
- **Link is not access.** Linking a CLINIC person (support `IDENTITY_LINK` case) joins it to the
  conflict identity only. It grants no booking visibility, ownership or medical access. Ownership
  (`claimed_by_user_id`) stays a separate concept.
- **This is not the medical-record identity.** Clinic patient profiles and future medical
  records are never re-linked by a booking-identity link.
- **Lock order extension:** idempotency key → clinic `FOR SHARE` → doctor(s) → **identity** →
  person → bookings. A link locks both identities in ascending order. The person is re-read
  after the identity lock, and if it moved meanwhile, the lock is re-taken (≤ 3 tries, then
  `409 CONFLICT`).

_Trade-off:_ a human with a CLINIC record and no proof stays a separate identity until support
links it. The database UNIQUE second line is still per person; the identity rule is enforced
under the identity lock.

## ADR-056: Overlaps found when linking are recorded, never auto-cancelled; links are correctable · Accepted (Task 05.2)

Two identities linked later may already hold overlapping bookings that were valid when made.
The link still succeeds. Each overlapping pair is recorded in `identity_link_conflicts` and
audited (`IDENTITY_LINK_CONFLICT`). Neither booking is cancelled or rescheduled. Confirming
either booking of the pair fails with `PATIENT_CONFLICT` until one stops holding time. Support
lists conflicts (`OPEN` while both bookings hold time) and records a resolution note.

An erroneous link is corrected by **revocation**:

- the person returns to its `origin_identity_id`;
- the link row becomes `REVOKED` (reason and actor kept);
- a link that was superseded by a newer one cannot be revoked (`409 IDENTITY_LINK_SUPERSEDED`;
  see ADR-057);
- ownership is released only when explicitly requested;
- the change is audited (`IDENTITY_LINK_REVOKED`).

History is never deleted or rewritten.

## ADR-057: Identity-link lifecycle: single-person links, supersede, self-approval, final conflict resolution · Accepted (Task 05.2.1; amends ADR-055/056)

Review of Task 05.2 left the lifecycle under-specified, and inspection found one defect:
`linkPersonInto` moved the person's **whole** current identity. Support-linking a walk-in who
was already linked to account A would therefore have moved A's own SELF person into account B's
identity. Now:

- **A link moves exactly one GUEST or CLINIC person into an account's identity.** SELF persons
  never move. A person owned by one account is never linked into another's
  (`IDENTITY_OWNED_ELSEWHERE`).
- **Supersede.** A newer verified link for an already-linked person replaces the active one,
  which becomes `SUPERSEDED` (`superseded_by_link_id`, append-only). At most one link per person
  is ACTIVE. A superseded link cannot be revoked (`IDENTITY_LINK_SUPERSEDED`), and revoking the
  current link returns the person to its own origin.
- **Self-approval** (`SELF_APPROVAL_FORBIDDEN`) extends to revocation and conflict resolution. It
  applies to any Super Admin whose account owns a person in, or originating from, an affected
  identity, or who acted on a conflict booking. It is checked in the service under the identity
  locks.
- **Conflict resolution only records.** It is refused while the overlap is live (both bookings
  hold time in one identity). It records actor, note, time and method (`BOOKING_RELEASED` |
  `LINK_REVOKED`), and it is final: an identical retry replays, anything else is `409`. The list
  distinguishes `OPEN`, `CLEARED` and `RESOLVED`.
- **Locking.** Link operations lock the current identities of all involved persons and
  re-check them under the lock (≤ 3 attempts), so a concurrent revoke or relink never leaves an
  operation acting on an unlocked identity.
- **Refusals are recorded** as `IDENTITY_OPERATION_REFUSED` security events after the rollback.

_Trade-off:_ a resolution cannot be reopened (by design). A wrong resolution note is corrected
by a new support record, not an edit.

---

## Open decisions

### OD-01 — Web bundler / dev server · Open

React + TypeScript is approved for the web apps, but the build tool (e.g. Vite) is not part of
the approved stack. The web workspaces are placeholders until this is decided.

### OD-02 — React Native and npm workspaces · Open

React Native CLI projects need Metro configuration (`watchFolders`, resolver) to work with npm
workspace hoisting, and native dependencies can need `nohoist`-style handling that npm does not
support. Options: configure Metro for the monorepo, or install mobile apps outside the
workspace hoisting. Decide when scaffolding the first mobile app.

### OD-03 — Tenant isolation mechanism · **Resolved by ADR-019 (Task 02)**

Remaining sub-questions: platform-scope (cross-clinic) queries for SUPER_ADMIN features, and how
background jobs obtain a `ClinicScope` from trusted job data.

### OD-04 — Reliable "DB write + enqueue job" · Open

A transactional outbox table polled by the worker, versus enqueue-after-commit with
reconciliation. Decide with the first feature that needs it.

### OD-05 — Redis distribution / license · Open

The dev stack uses `redis:7.4-alpine`. Production Redis (managed service, Redis 8, or Valkey) and
its license implications are a deployment decision. BullMQ only needs Redis ≥ 6.2-compatible
semantics.

### OD-06 — Real OTP delivery provider · Open (blocks production)

SMS / WhatsApp / other provider, sender registration, cost controls and anti-pumping measures.
Production refuses to start with the mock provider.

### OD-07 — When is the PATIENT role granted? · **Resolved by ADR-045 (Task 05): on first patient booking use**

Automatically on first login from a patient app, on first booking, or explicitly? Currently never
automatic (granted via `npm run role:grant` or future flows).

### OD-08 — Refresh-token reuse grace window · Open

Strict today: a parallel refresh with the same token logs the device out. A grace window of a
few seconds for the immediately preceding token would be friendlier to mobile clients but
weakens theft detection.

### OD-09 — Web token storage · Open

Body-based refresh tokens work for mobile. For web apps: `HttpOnly` + `SameSite` cookies with CSRF
protection, or a BFF. Decide with the first web app.

### OD-10 — Effect of clinic operational / subscription status on access · Open

Should members of a suspended or unpaid clinic lose access (fully, read-only, or not at all)?
Not enforced until the clinic module defines those statuses.

### OD-11 — 2FA reset / revocation workflow · Open

Who may reset a lost authenticator (another SUPER_ADMIN?), which identity re-verification is
required, and whether 2FA should be offered or required for clinic owners.

### OD-12 — Clinic owner appointment and transfer · Open

Currently only an MFA-verified SUPER_ADMIN can grant or terminate CLINIC_OWNER memberships. Ownership
transfer and multi-owner rules belong to the clinic-registration task.

### OD-13: Cloudflare R2 private storage integration · Open (blocks production)

Bucket, credentials, signed-URL strategy (direct upload or proxied), malware scanning and
retention.

### OD-14: Should CLINIC_MANAGER hold `clinic.branches.manage`? · Open

The specification says "owner or authorized manager"; the approved Task 02 mapping is owner-only.
Changing it requires a mapping migration.

### OD-15: Invitation delivery · Open

The token is currently returned to the inviter. A notification provider (SMS/WhatsApp/email)
should deliver it and stop returning it.

### OD-16: Payment gateway and automatic renewals · Open

Provider choice, webhooks into `recordPayment`, invoices and tax handling.

### OD-17: Memberships after closure · Open

Memberships are kept with read-only access after CLOSED. Should they be terminated
automatically after a retention period?

### OD-18: Who may edit clinic name and legal identity after approval · Open

These are currently not editable by the clinic. A platform-reviewed change request is the
likely design.

### OD-19: Approval with a plan that has no trial days · **Resolved by ADR-038 (Task 03.2)**

The Task 03.1 brief describes approval as "initializes its trial subscription". The
implementation (ADR-028) creates TRIAL only when the plan version has trial days, and PAST_DUE
otherwise. Options: keep it; require trial days > 0 for plans offered at approval; or always
start a trial of a platform-default length. No change was made in Task 03.1.

### OD-20: Should a doctor's specialties restrict the services they may provide? · Open (Task 04)

Doctor ↔ service eligibility is explicit, and specialty matching is not enforced. Enforcing it
(service `specialty_code` ∈ doctor specialties) could block general services and
multi-specialty doctors.

### OD-21: Conflicts between a doctor's schedules in different clinics · Open (Task 04)

Conflicts are checked within one clinic. Checking across clinics would reveal one clinic's
schedule to another, and would let one clinic block another. This needs a product and privacy
decision (for example, a doctor-owned availability view).

### OD-22: Travel time between branches · Open (Task 04)

Back-to-back periods at two branches (one ends when the other starts) are allowed. A minimum
gap per branch pair is not modelled.

### OD-23: Should terminating a DOCTOR membership end its branch assignments? · Open (Task 04)

Today the assignment stays ACTIVE but becomes ineffective (`MEMBERSHIP_INACTIVE`), and it
becomes effective again if the membership is reactivated. An automatic end would be simpler to
read, but it would couple the membership module to clinic setup.

### OD-24: Queryable price history for offerings · Open (Task 04)

Price and duration changes are audited (before/after) but overwrite the offering row. A future
Booking Engine should snapshot the price on each booking. A separate price-history table may be
needed for reporting.

### OD-25: Staff-created bookings (phone/walk-in) · **Resolved by ADR-052 (Task 05.1)**

Clinic staff can confirm, reject, cancel and see bookings, but cannot create one for a caller or
walk-in. That needs a staff patient-lookup/creation flow with consent capture at the clinic.

### OD-26: Guest booking for another person · Open (Task 05)

Guests book for the verified phone's own person only. Dependents and consent delegations need an
account.

### OD-27: Account phone changes and booking persons · **Partly resolved (Task 05.1)**: verified phone change and recycled-number safety (ADR-050/051); person merge and booking transfer remain a future support tool

A SELF person is keyed by the verified phone. A phone change, or a recycled number already
linked to another account (`PERSON_LINK_CONFLICT`), needs a support-mediated re-link process.

### OD-28: Should booking require Marketplace eligibility? · Open (Task 05)

Booking requires the clinic to accept new operations. It does not require Marketplace
visibility, so a patient who knows the clinic can book directly.

### OD-29: Outbox publisher and notification consumers · Open (Task 05; extends OD-04/OD-15)

Booking events are written reliably to the outbox. The publisher and the patient/clinic
notification consumers (provider integration, templates, opt-outs) are future work.

### OD-30: Same human with two booking persons after a claim · **Resolved (Task 05.2, ADR-055/056)**

A claimed guest person and the account's own SELF person were kept separate, so patient
conflict checks did not cross between them. Resolved without merging: claims and audited support
links join persons to one canonical booking identity, which is the conflict key. Dual-approval
support tooling remains part of OD-27.
