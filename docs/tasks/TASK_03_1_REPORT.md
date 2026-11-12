# Task 03.1 report: Specialty permission, platform decisions, migration policy, docs restructure

| Field  | Value                                                   |
| ------ | ------------------------------------------------------- |
| Task   | 03.1, a correction to Task 03 before its final approval |
| Date   | 2026-11-11                                              |
| Status | Awaiting project-owner review                           |
| Next   | Owner review. **Task 04 not started.**                  |

## A. Summary

1. A new permission, `platform.specialties.manage`, now guards the specialty catalog.
   `platform.doctors.verify` guards doctor review only. Both directions are tested.
2. Decisions A (registration `SUSPENDED`), B (atomic approval) and C (ownership transfer)
   were checked against the code. The code matches all three, so no product code changed for
   them. Each is now documented in detail and covered by new regression tests.
3. A migration policy is documented ([DATABASE_MIGRATIONS.md](../development/DATABASE_MIGRATIONS.md)).
   The permission was folded into the unreleased migration `150025`, and both disposable
   databases were rebuilt and validated.
4. The documentation was reorganized into category folders, with a new
   [docs index](../README.md). All references were updated and checked.

## B. New permission and migration

| Item       | Value                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Permission | `platform.specialties.manage` · scope PLATFORM · "Manage the specialty catalog"                                                      |
| Granted to | `SUPER_ADMIN` only (still subject to the mandatory MFA-verified session for every PLATFORM permission)                               |
| Catalog    | `apps/backend/src/modules/access/authorization/catalog.ts` (`PERMISSIONS` and `ROLE_PERMISSIONS`)                                    |
| Migration  | **amended** `20261111150025_add_platform_clinic_permissions.sql`: one `permissions` row and one `role_permissions` row. No new file. |

The task prompt asks for "an additive database migration". The addendum's migration policy
overrides that by preferring an amendment to an unreleased migration. The change is still
additive in effect: it adds a row, and no existing grant changes.

## C. Authorization changes

| Endpoint / service                                                                                       | Before                    | After                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------- |
| `PUT /admin/specialties/:code` → `SpecialtyService.upsert` (create, rename, deactivate)                  | `platform.doctors.verify` | **`platform.specialties.manage`** |
| `GET /admin/doctor-profiles`, `GET /admin/doctor-profiles/:id`, document download, `POST …/verification` | `platform.doctors.verify` | unchanged                         |
| `GET /specialties`                                                                                       | public                    | unchanged                         |

The catalog has **no hard-delete endpoint**. "Delete" means deactivation (`active: false`, a
soft delete), and doctor references are protected by `ON DELETE RESTRICT`. No delete endpoint
was added, because that would be out of scope.

## D. Authorization test results

**Unit**: `src/modules/doctor-profiles/permissions.test.ts` (new, 9 tests, all passed). Fakes
grant exactly one permission and record every write:

- SUPER_ADMIN holds both permissions, and no other role holds `platform.specialties.manage`.
- ✅ Positive: `specialties.manage` allows create, rename and deactivate (3 audited writes).
- ❌ Negative: `doctors.verify` only → create, rename and deactivate get 403, with **zero writes**.
- ✅ Positive: `doctors.verify` allows the review listing.
- ❌ Negative: `specialties.manage` only → APPROVE, REJECT, SUSPEND and REINSTATE get 403 with
  zero writes. The review list, review detail and document download also get 403.

**API**: `tests/integration/platform/specialty-permissions.test.ts` (new, 6 tests, all
passed). It uses two test-only PLATFORM roles that hold exactly one permission each, removed
afterwards:

- The migration seeds the permission, and only SUPER_ADMIN holds it.
- SUPER_ADMIN manages the catalog **and** approves doctors.
- ✅ Curator (`specialties.manage` only) creates, renames and deactivates. The DB rows and the
  public list reflect the changes.
- ❌ Curator: review list and detail get `FORBIDDEN`. APPROVE, REJECT and SUSPEND get 403,
  including SUSPEND on a verified profile, and the status is unchanged.
- ❌ Reviewer (`doctors.verify` only): create, rename and deactivate get 403. The catalog is
  unchanged, with no `SPECIALTY_CHANGED` audit row.
- ✅ Reviewer lists, approves, suspends and reinstates.

**Mutation check (performed):** I temporarily reverted `SpecialtyService.upsert` to
`platform.doctors.verify`. 2 unit tests and 2 API tests failed, as expected. Then I restored it.

## E. Decisions A, B and C

| Decision                        | Code check                                                                                                                                                                                                                                | Result                   | Docs / ADR                                                                                                                | New regression test                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**: registration `SUSPENDED` | `REGISTRATION_LIFECYCLE`. Only the registration module writes `clinic_registration_requests.status`. Cross-effects: approval initializes; closure expires the subscription.                                                               | **Consistent**           | CLINIC_REGISTRATION.md (meaning, transitions, affected operations, three status dimensions); CLINIC_LIFECYCLE.md; ADR-027 | `registration.test.ts`: frozen review blocks edits, upload, submit, approve and request-info; reads allowed; reject works; no clinic                                                                                      |
| **B**: atomic approval          | One `db.transaction`, request row `FOR UPDATE`, no external side effects. Subscription init inside the transaction.                                                                                                                       | **Consistent** (see F.1) | CLINIC_REGISTRATION.md "Failure and retry"; ADR-028                                                                       | `registration.test.ts`: failure _after_ the clinic, branch and owner inserts leaves 0 rows and the request UNDER_REVIEW; retry creates exactly 1 of each (TRIAL); second approval gets `INVALID_TRANSITION`               |
| **C**: ownership transfer       | Completion terminates **every** non-terminated membership of the previous owner in that clinic only. The account, global roles, sessions and other clinics are untouched. Invitation acceptance reactivates the terminated same-role row. | **Consistent**           | OWNERSHIP_TRANSFER.md "What happens to the previous owner"; ADR-031                                                       | `ownership-transfer.test.ts`: OWNER and DOCTOR both terminated; other clinic's OWNER, account status and PATIENT role untouched; re-invite as CLINIC_OWNER rejected (400); re-invite as DOCTOR works without owner powers |

## F. Remaining deviations, findings and open points

1. **Trial subscriptions (decision B).** The brief says approval "initializes its trial
   subscription". The code creates TRIAL only when the plan has trial days, and PAST_DUE
   otherwise (ADR-028, unchanged). This is recorded as **OD-19** for the owner. Changing it
   would be a business-rule change, which is outside this correction.
2. **Stale effective window on re-invitation (found while checking C, not changed).**
   Reactivating a terminated membership on invitation acceptance resets status and branches,
   but keeps the old row's `effective_from` / `effective_until`. Only the platform
   direct-grant path can set those, and transfer and invitation rows use `NULL`, so this is
   rare. Still, if a previous membership had an `effective_until` in the past, the
   re-invited membership would be ACTIVE but not effective. A suggested fix is to clear both
   columns on reactivation in `StaffService.accept`. It was not applied because it changes the
   staff module outside this correction's scope.
3. **Stale path in a migration comment.** `20261111140007_create_role_permissions.sql` still
   mentions `architecture/AUTHORIZATION.md`. It was not edited, so the migration's checksum
   would not change for a comment. This is documented in DATABASE_MIGRATIONS.md §10.
4. `development/CODE_CONVENTIONS.md` from the target structure: the existing
   `CODING_STANDARDS.md` already fills that role and was kept under its name to avoid churn.
   No `IDENTITY_API.md`, `operations/` or `product/` documents were created, because no content
   exists for them yet (the index says so).
5. ADR-026 (operating policy matrix) is still open for approval. It was not part of this
   correction.

## G. Migration policy summary

| Migration                                        | Action       | Why                                                                                                                                                       |
| ------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261111150025_add_platform_clinic_permissions` | **Modified** | It owns the Task 03 permission seed. Unreleased: no commits, no remote. Applied only to the two disposable local databases (`medibook`, `medibook_test`). |
| `20261111140007_create_role_permissions`         | not modified | Comment-only stale doc path; not worth a checksum change                                                                                                  |
| any new migration                                | none added   | Policy §3 prefers amending unreleased migrations                                                                                                          |

Safety steps taken, in order:

1. Read the runner. It uses `schema_migrations`, SHA-256 checksums verified on `up` and
   `status`, refuses mismatches, missing files and out-of-order files, and uses a `GET_LOCK`.
2. Found the databases. `docker ps` showed one local MySQL container, with databases
   `medibook` and `medibook_test`, each with 45 applied and the latest `150025`. No
   shared/Staging/Production database exists, and the git repository has no commits and no
   remote.
3. Inspected the dev data before dropping it. It held only one local Super Admin smoke-test
   account and its OTP, session and security rows, all re-creatable with `npm run role:grant`.
4. Confirmed the runner rejects the edit on the old databases: `npm run migrate` →
   `Checksum mismatch for applied migration "20261111150025_add_platform_clinic_permissions.sql"`.
5. Dropped and re-created both schemas (utf8mb4_0900_ai_ci). The DB-level grants for the app
   user survived (verified with `SHOW GRANTS`). Ran the full migration sequence.
6. Validated: 45 applied / 0 pending; a second `migrate` applied `count: 0`. Dev and test
   `information_schema` dumps (columns, indexes, FKs, checks, migration checksums, roles,
   permissions, grants; 914 lines each) were **identical**. The identity-schema catalog-sync
   test passed. No tracking rows were edited by hand.

The permanent policy (development phase, shared environments, Production immutability,
procedures, failures, backups) is in
[DATABASE_MIGRATIONS.md](../development/DATABASE_MIGRATIONS.md) and ADR-036.

## H. Documentation changes

New: [docs/README.md](../README.md) (index and conventions),
[development/DATABASE_MIGRATIONS.md](../development/DATABASE_MIGRATIONS.md), this report.
New ADRs: **035** (specialty permission), **036** (migration policy), **037** (docs
structure). New open decision: **OD-19**. ADR-007 has an amendment note. ADR-027, ADR-028 and
ADR-031 changed from "needs approval" to "confirmed in Task 03.1", with clarifications.

Updated content: PLATFORM_AUTHORIZATION (new row and requirement #13), PLATFORM_API (specialty
permission), DOCTOR_PROFILES (new "Specialty catalog" section), security/AUTHORIZATION (pointer
to the Task 03 grants), PLATFORM_DATABASE_SCHEMA (150025 now has 13 permissions),
CLINIC_REGISTRATION (decisions A and B), CLINIC_LIFECYCLE (independence note),
OWNERSHIP_TRANSFER (decision C), CODING_STANDARDS and ENVIRONMENT_SETUP (link to the migration
policy), `apps/backend/migrations/README.md` (was stale: "No business schema exists yet"), the
migration template comment, the root README (links to the index), the tasks index (row 03.1),
and TASK_03_REPORT (superseded and confirmed annotations; historical text kept). Every major
document now starts with a `Purpose:` line.

### Documentation moves

| Original path                         | New path                                   | Reason                                        |
| ------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| docs/architecture/AUTHENTICATION.md   | docs/security/AUTHENTICATION.md            | security topic                                |
| docs/architecture/AUTHORIZATION.md    | docs/security/AUTHORIZATION.md             | security topic                                |
| docs/architecture/TENANT_ISOLATION.md | docs/security/TENANT_ISOLATION.md          | security topic                                |
| docs/decisions/DECISIONS.md           | docs/architecture/decisions/DECISIONS.md   | ADRs belong with architecture (target layout) |
| docs/PLATFORM_ARCHITECTURE.md         | docs/architecture/PLATFORM_ARCHITECTURE.md | architecture                                  |
| docs/PLATFORM_API.md                  | docs/api/PLATFORM_API.md                   | API reference                                 |
| docs/PLATFORM_DATABASE_SCHEMA.md      | docs/database/PLATFORM_DATABASE_SCHEMA.md  | schema reference                              |
| docs/PLATFORM_AUTHORIZATION.md        | docs/platform/PLATFORM_AUTHORIZATION.md    | platform domain (target layout)               |
| docs/BRANCH_MANAGEMENT.md             | docs/platform/BRANCH_MANAGEMENT.md         | platform domain rules                         |
| docs/CLINIC_LIFECYCLE.md              | docs/platform/CLINIC_LIFECYCLE.md          | platform domain rules                         |
| docs/CLINIC_MEMBERSHIPS.md            | docs/platform/CLINIC_MEMBERSHIPS.md        | platform domain rules                         |
| docs/CLINIC_REGISTRATION.md           | docs/platform/CLINIC_REGISTRATION.md       | platform domain rules                         |
| docs/DOCTOR_PROFILES.md               | docs/platform/DOCTOR_PROFILES.md           | platform domain rules                         |
| docs/MARKETPLACE_ELIGIBILITY.md       | docs/platform/MARKETPLACE_ELIGIBILITY.md   | platform domain rules                         |
| docs/OWNERSHIP_TRANSFER.md            | docs/platform/OWNERSHIP_TRANSFER.md        | platform domain rules                         |
| docs/SUBSCRIPTION_MANAGEMENT.md       | docs/platform/SUBSCRIPTION_MANAGEMENT.md   | platform domain rules                         |

Unmoved (already in place): architecture/ARCHITECTURE.md, architecture/IDENTITY_ARCHITECTURE.md,
database/IDENTITY_SCHEMA.md, development/_, security/SESSION_MANAGEMENT.md,
security/THREAT_MODEL.md, tasks/_. File contents were preserved; only links, purpose lines and
the edits listed above changed. The empty `docs/decisions/` folder was removed. No files
remain directly under `docs/` except the index.

Each file was moved with a script that resolved every relative link against the linking
file's _original_ location and rewrote it for both files' new locations. It also rewrote
repo-root `docs/…` strings (READMEs, `catalog.ts`). A checker then resolved **183** references
(Markdown links, `#anchors` and `docs/…` paths across the repo). After this report was written,
the only unresolved reference was the deliberate migration comment (F.3).

## I. Commands executed and results

| Command                                                                                                    | Result                                                          |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run migrate` (before the rebuild, after editing 150025)                                               | ❌ expected: `Checksum mismatch … 20261111150025…`              |
| drop/create `medibook` + `medibook_test`, then `npm run migrate`                                           | ✅ `count: 45`                                                  |
| `npm run migrate:status`, then `npm run migrate` again                                                     | ✅ 45 applied, 0 pending; `count: 0`                            |
| dev vs test `information_schema` + catalog dump `diff`                                                     | ✅ identical (914 lines each)                                   |
| `npx vitest run src/modules/doctor-profiles/permissions.test.ts`                                           | ✅ 9 passed                                                     |
| `vitest --config vitest.integration.config.ts …/specialty-permissions …/identity-schema …/doctor-profiles` | ✅ 3 files, 20 passed                                           |
| mutation check (service reverted to `doctors.verify`)                                                      | ✅ detected: 2 unit + 2 API failures; then restored             |
| `vitest --config vitest.integration.config.ts tests/integration/platform/registration.test.ts`             | ✅ 11 passed (2 new)                                            |
| `vitest --config vitest.integration.config.ts tests/integration/platform/ownership-transfer.test.ts`       | ✅ 8 passed (1 new)                                             |
| `npm run format:check`                                                                                     | ✅ after `prettier --write` on the 8 files changed in this task |
| `npm run lint`                                                                                             | ✅ (1 error in my new test fixed first: a wrong row type)       |
| `npm run typecheck`                                                                                        | ✅                                                              |
| `npm test` (all workspaces)                                                                                | ✅ 21 files, **213 passed**                                     |
| `npm run test:integration` (real MySQL 8.4 + Redis 7.4, rebuilt schema)                                    | ✅ 19 files, **190 passed** (Task 03: 18 / 181; +9 new tests)   |
| `npm run build`                                                                                            | ✅                                                              |
| `curl /health/ready` on the running dev backend after the rebuild                                          | ✅ 200                                                          |

## J. Bugs found and fixed during verification

None in product code. Test-authoring fixes only: the error field is `statusCode` (not
`status`), MySQL `COUNT(*)` comes back as strings, a reason string was below the minimum
length, the admin registration GET response is nested, and the transfer approval needs a
reason.

## K. Manual follow-ups

- Re-create a local Super Admin for manual testing: sign in once with OTP, then
  `npm run role:grant -- <phone> SUPER_ADMIN`. The dev database was rebuilt.
- Owner decisions: OD-19 (trial-less approval) and finding F.2 (re-invitation effective window).
