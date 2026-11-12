# Task 04 report: Doctors, branches, services and schedules

| Field  | Value                                                                  |
| ------ | ---------------------------------------------------------------------- |
| Task   | 04: clinical configuration layer                                       |
| Date   | 2026-11-11                                                             |
| Status | Awaiting project-owner review                                          |
| Next   | Owner review. **Task 05 not started; no booking functionality built.** |

## 1. Implemented scope

All six objectives are implemented with APIs, authorization, validation, auditing, tests and
documentation:

1. **Doctor branch assignments.** The doctor's eligibility is checked when they are assigned
   (active DOCTOR membership covering the branch, VERIFIED + ACTIVE global profile), and
   `effective`/`blockers` are recomputed on every read. A doctor can be assigned to several
   branches. Deactivation keeps history. Duplicates are prevented by the clinic lock plus a
   unique key.
2. **Clinic service catalog.** Bilingual services (EN/AR) with an optional specialty link,
   custom services and an optional clinic code. Activation and deactivation keep every
   reference.
3. **Branch offerings.** Each offering has its own price (integer minor units, ISO 4217,
   default EGP), duration, buffer and bilingual instructions. Writes are idempotent `PUT`
   upserts.
4. **Doctor ↔ service eligibility.** Explicit per branch, pinned by composite FKs to the same
   clinic and branch, with optional per-doctor overrides. History is kept.
5. **Branch operating hours.** Weekly versions with several periods per day, breaks, effective
   dates and revisions, plus holiday, temporary-closure and exceptional-hours exceptions. Time
   zones are IANA identifiers; overnight shifts are entered as two periods.
6. **Doctor schedules.** Weekly versions per assignment, with breaks, effective dates,
   revisions, activation/deactivation, leave, partial unavailability and additional periods.
   They must fit within branch hours. Cross-branch conflicts are computed in real UTC time with
   each branch's zone. DST follows one documented rule. Concurrent writes are serialized.
   **Resolved working time** per date (local + UTC) is the foundation for booking; it is
   **not** slots.

Explicitly **not** implemented (per §11): booking, slots, reservations, queue, medical records,
prescriptions, UI, notifications, payments, Marketplace search.

### Pre-implementation inspection (what was reused)

Reused, not duplicated:

- `clinic_memberships` + `clinic_membership_branches` (coverage), `doctor_profiles`
  (verification), `specialties`, `clinic_branches.time_zone` (existing IANA validation);
- `TenantContextResolver` (re-resolving path branches), `ClinicScope` + `tenantExecutor`,
  `AuthorizationService` + `ClinicOperationGate`, `MembershipService.lockClinic` (ADR-034);
- `AuditLog`, `DomainEventOutbox`, `PlatformSettingsService`, `toPage`, the validation
  middleware, the error envelope, and money in minor units (ADR-029).

Overlaps found and resolved:

- membership branch scope (access) vs the new assignment (work), see ADR-040;
- the existing `clinic.doctors/services/schedules.manage` permissions, which are reused for
  writes.

The migration policy was verified: no existing migration is touched; new forward-only files
only.

## 2. Architecture and database changes

- New module `apps/backend/src/modules/clinic-setup/`: `context.ts` (branch re-resolution,
  eligibility), `assignments.service.ts`, `catalog.service.ts`, `schedules.service.ts`,
  `time-zone.ts` and `weekly.ts` (pure, unit-tested), `schemas.ts`, `setup.routes.ts`. It is
  wired in `container.ts`.
- Small changes in existing code:
  - permission catalog (+2);
  - platform setting `clinic.default_currency` (EGP);
  - audit actions and target types;
  - `BranchAccessDeniedError` export;
  - `ClinicService.updateBranch` time-zone lock (ADR-043);
  - integration harness table list.
- ADRs **040–043**, open decisions **OD-20–OD-24**.

## 3. Migrations (new; none modified)

| Migration ID     | Tables / indexes                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261111160001` | `doctor_branch_assignments`: UNIQUE active `(clinic_id, branch_id, membership_id, active_key)`, `(clinic_id, branch_id, id)`, ix branch/status, membership, doctor |
| `20261111160002` | `clinic_services`: UNIQUE `(clinic_id, code)`, `(clinic_id, id)`, ix status, specialty                                                                             |
| `20261111160003` | `branch_service_offerings`: UNIQUE `(clinic_id, branch_id, service_id)`, `(clinic_id, branch_id, id)`, ix service                                                  |
| `20261111160004` | `doctor_service_assignments`: UNIQUE active `(clinic_id, assignment_id, offering_id, active_key)`, ix offering, assignment                                         |
| `20261111160005` | `schedules` (ix branch/owner/status/from, assignment/status/from, supersedes) and `schedule_periods` (ix schedule/day)                                             |
| `20261111160006` | `schedule_exceptions`: ix branch/owner/status/start, assignment/status/start                                                                                       |
| `20261111160007` | permissions `clinic.services.view`, `clinic.schedules.view` and 8 role grants                                                                                      |

Details are in [CLINIC_SETUP_SCHEMA.md](../database/CLINIC_SETUP_SCHEMA.md).

## 4. API endpoints and permissions

There are 33 routes under `/api/v1/clinic/...`. The full table and examples are in
[CLINIC_SETUP_API.md](../api/CLINIC_SETUP_API.md). Summary:

| Area                                               | Read permission                          | Write permission                   |
| -------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| Doctor assignments                                 | `clinic.schedules.view` (branch)         | `clinic.doctors.manage`            |
| Services                                           | `clinic.services.view`                   | `clinic.services.manage`           |
| Branch offerings                                   | `clinic.services.view` + branch coverage | `clinic.services.manage`           |
| Doctor ↔ service                                   | `clinic.services.view` + branch          | `clinic.doctors.manage`            |
| Hours, schedules, exceptions, working/opening time | `clinic.schedules.view` (branch)         | `clinic.schedules.manage` (branch) |

## 5. Schedule and time-zone decisions

- Schedules are immutable dated versions; a change is a revision, never an in-place edit.
- Periods are local wall-clock minutes of the branch's IANA zone and never cross midnight
  (overnight = two periods). Effective dates are inclusive local dates, and the start must be
  the branch's local today or later.
- **DST rule:** a local time maps to the first instant the local clock reads ≥ that time.
  - Nonexistent times clip to the transition (01:00–04:00 on the spring day = 2 real hours).
  - Ambiguous times take the first occurrence (00:00–03:00 on the fall day = 4 real hours;
    01:00–01:30 = 30 minutes).
  - Nothing is shifted to an unintended wall time. Unit-tested for New York and Cairo, and
    integration-tested end to end.
- Cross-branch conflicts are checked in real UTC time with each branch's own zone, over 371
  days, within the clinic only (OD-21). A seasonal Cairo/London conflict is detected (tested).
- A branch's time zone is locked while it has active schedules or exceptions.
- No new dependency: `Intl` with ICU tzdata 2025b (Node 20.19.4).

## 6. Validation and concurrency rules

- **Periods:** start < end; WORK periods don't overlap per day; BREAK lies inside WORK; at
  least 1 and at most 70 periods. Active versions of one owner don't overlap in dates.
- **Doctor schedule:** covered by branch versions (`BRANCH_HOURS_NOT_COVERED`), inside branch
  weekly time incl. breaks (`OUTSIDE_BRANCH_HOURS`), and no cross-branch overlap
  (`DOCTOR_SCHEDULE_CONFLICT`). A doctor EXTRA must be inside the branch's resolved time that
  date.
- **Reverse direction:** branch revisions and deactivations cannot strand doctor schedules
  (`BRANCH_HOURS_IN_USE`). Branch date exceptions resolve by intersection.
- **Ownership checks:** cross-clinic ids → 404. A path branch the caller doesn't cover → 404.
  Eligibility, offering and service status are checked in the transaction.
- **Concurrency:** every setup write locks the clinic row first, then reads and validates
  inside the same transaction. Unique `active_key` columns are a second barrier for
  assignments and doctor services.
- **Mutation checks (performed, then restored):**
  - removing the clinic lock in `createDoctorSchedule` made the concurrency test fail 3 out of
    3 runs;
  - disabling the cross-branch check failed 3 tests.

## 7. Tests executed and results

| Suite                                                                      | Result                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| Unit `clinic-setup/time-zone.test.ts` (new)                                | ✅ 7 passed                                       |
| Unit `clinic-setup/weekly.test.ts` (new)                                   | ✅ 8 passed                                       |
| Integration `clinic-setup/assignments.test.ts` (new)                       | ✅ 5 passed                                       |
| Integration `clinic-setup/services.test.ts` (new)                          | ✅ 6 passed                                       |
| Integration `clinic-setup/schedules.test.ts` (new)                         | ✅ 13 passed                                      |
| Integration `clinic-setup/security.test.ts` (new)                          | ✅ 6 passed                                       |
| `npm test` (all unit tests, all workspaces)                                | ✅ 23 files, **228 passed** (Task 03.2: 21 / 213) |
| `npm run test:integration` (Task 01–04 suites, real MySQL 8.4 + Redis 7.4) | ✅ 24 files, **229 passed** (Task 03.2: 20 / 199) |
| `npm run test:clinic-setup`                                                | ✅ 4 files, 30 passed                             |

What the security and regression tests cover:

- cross-tenant id manipulation on 14 endpoints, plus a foreign `X-Clinic-Id`;
- branch-scoped managers and receptionists;
- FULL vs NEW_OPERATIONS suspension;
- restricted subscription;
- membership termination and verification suspension;
- audit and outbox content (no prices);
- unauthenticated access, and a Super Admin without clinic access.

The requested cases map to these tests:

| Area        | Cases covered                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assignments | eligible / ineligible (5 reasons) / cross-clinic / duplicate + race / history / authorization                                                                                            |
| Services    | custom / bilingual / specialty / branch prices / multi-doctor / cross-branch and cross-clinic / deactivation / permissions                                                               |
| Hours       | multiple periods / breaks / invalid / overlap / effective boundaries / holidays / closures / exceptional hours / time zone / overnight                                                   |
| Schedules   | containment / outside / break / no hours / overlap / two branches / seasonal TZ conflict / boundaries / leave / extra / concurrency / DST / deactivation + activation / doctor read-only |

## 8. Build, lint, typecheck, format

| Command                | Result                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check` | ✅ (after `prettier --write` on changed files)                                                                                      |
| `npm run lint`         | ✅. The first run had 33 errors in new code (unnecessary `String()`, base-to-string, non-null assertions); fixed, never suppressed. |
| `npm run typecheck`    | ✅                                                                                                                                  |
| `npm run build`        | ✅                                                                                                                                  |

Migration verification:

- `npm run migrate` on dev applied 7. `migrate:status` shows 52 applied, 0 pending, and a
  re-run applies 0.
- The test database is migrated by the integration setup.
- The dev vs test `information_schema` + catalog dump is **identical** (1122 lines).
- A fresh scratch database built from all 52 files has 50 tables and 78 role grants, equal to
  dev. The scratch database was dropped afterwards.

## 9. Known limitations and remaining risks

- **Unpaginated lists:** a doctor's branches, a doctor's services and the doctors of a service
  are capped at 200/500 rows. Schedules, exceptions, assignments, services and offerings are
  paginated.
- **Idempotency:** only the `PUT` upserts are idempotent. Create `POST`s have no
  `Idempotency-Key` support; repeats get `409` where a uniqueness rule applies.
- **Conflict horizon:** cross-branch checks cover 371 days. Beyond that they rely on yearly
  repetition of DST rules. A future tzdata change to a zone is not re-validated against
  existing schedules.
- **Not detected:** conflicts across clinics (OD-21) and travel time between branches (OD-22).
- **Doctor exceptions vs later branch changes:** a doctor EXTRA validated against branch time
  is not re-validated if the branch later adds a closure. Resolution intersects, so the doctor
  simply has no time that day.
- **Terminated memberships:** assignments remain ACTIVE but ineffective (OD-23).
- **Price history:** audited before/after only (OD-24).
- **Specialty matching:** not enforced for doctor services (OD-20).
- **Serialization:** every setup write serializes per clinic (rare admin writes; documented
  trade-off).

## 10. Deviations from the brief

- **"Subscription restrictions" do not block configuration.** This follows ADR-026, under which
  a restricted subscription blocks only NEW_OPERATION and growth. Configuration is
  ADMINISTRATION, and a test asserts this documented behaviour. If you want setup blocked for
  unpaid clinics, that is an ADR-026 change.
- **Overnight periods** are supported as two periods across midnight, not as one period. This
  is the unambiguous representation §4 allows.
- **No platform service catalog was created.** None existed, and §3 says a global catalog must
  not be mandatory. The optional link is to platform specialties.
- **One Task 02 contract test was updated** (`api.test.ts`, the receptionist permission list)
  to include the two new view permissions. This is the same strict equality, not weakened.
- **`GET /clinic/me/doctor-assignments`** uses `clinic.profile.view` (any member) plus
  ownership filtering, rather than a new permission.

## 11. Exact verification commands

```bash
npm run migrate && npm run migrate:status && npm run migrate        # dev: 7 applied → 52/0 → count 0
npx vitest run src/modules/clinic-setup/                            # in apps/backend
npx vitest run --config vitest.integration.config.ts tests/integration/clinic-setup/   # in apps/backend
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run test:integration
npm run test:clinic-setup
# schema parity: information_schema dump of medibook vs medibook_test → diff (identical)
# fresh build: all 52 migration files into a scratch schema → 50 tables, 78 grants → dropped
```

## 12. Documentation

New:

- [DOCTOR_ASSIGNMENTS.md](../platform/DOCTOR_ASSIGNMENTS.md)
- [SERVICE_CATALOG.md](../platform/SERVICE_CATALOG.md)
- [SCHEDULES.md](../platform/SCHEDULES.md)
- [CLINIC_SETUP_API.md](../api/CLINIC_SETUP_API.md)
- [CLINIC_SETUP_SCHEMA.md](../database/CLINIC_SETUP_SCHEMA.md)

Updated:

- DECISIONS.md (ADR-040–043, OD-20–24), PLATFORM_ARCHITECTURE.md (module), PLATFORM_AUTHORIZATION.md
  (Task 04 permissions), DOCTOR_PROFILES.md (link), TESTING_GUIDELINES.md (suite)
- `docs/README.md`, the root README (links and script) and the tasks index

There are no empty documents or folders. All 257 doc references resolve, except the known
historical migration comment.
