# Task 03 report: Platform & clinic management

| Field  | Value                                              |
| ------ | -------------------------------------------------- |
| Task   | 03: Platform & Clinic Management                   |
| Date   | 2026-11-11                                         |
| Status | **Complete; awaiting review and approval**         |
| Next   | Task 04 must not start until this task is approved |

## Pre-implementation findings

Tasks 01 and 02 were complete and green. Nothing blocked a safe implementation. Four gaps were
closed with small, additive adjustments:

1. **No private storage:** a `PrivateObjectStorage` interface plus a dev-only local provider
   (ADR-032).
2. **No central clinic-state enforcement:** permission categories plus a `ClinicOperationGate`
   injected into `AuthorizationService` (ADR-025).
3. **Minimal anchor tables:** `clinics`, `clinic_branches` and `doctor_profiles` were extended
   by additive migrations.
4. **No deactivated membership state:** `INACTIVE` added.

Reused without duplication: users, OTP, tokens and sessions; the catalog and authorization
service; tenant context and `ClinicScope`; `MembershipService`; the audit and security logs;
the migration system; the test harness.

## A. Implementation summary

| Domain                  | Implemented                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform administration | Platform settings (validated, audited), granular `platform.*` permissions, Super Admin clinic list/detail                                                                                                                                                              |
| Clinic registration     | Drafts, edit, private documents, submission completeness, review workflow (7 statuses, applicant vs reviewer transitions), self-approval prevention, review history, atomic approval                                                                                   |
| Clinic lifecycle        | Operational state machine; suspension (FULL / NEW_OPERATIONS) with history and reinstatement; continuity-of-care access exceptions; closure request → review → CLOSING with required actions → completion                                                              |
| Branches                | CRUD, activate/deactivate, coordinates/time zone/contacts/settings, coverage-filtered listing, plan limit                                                                                                                                                              |
| Doctor profiles         | Global profile, specialties catalog, qualifications, license data (locked when verified), verification workflow with history and private documents                                                                                                                     |
| Memberships and staff   | Lifecycle incl. INACTIVE, last-owner guard, outstanding-work hook, branch assignments, doctor public listing, member list                                                                                                                                              |
| Invitations             | Phone-bound, hashed, single-use, expiring, revocable; inviter authority re-checked on acceptance; capacity check                                                                                                                                                       |
| Ownership transfer      | Owner initiation, recipient acceptance, identity verification, required agreement document, non-party Super Admin approval, atomic swap                                                                                                                                |
| Subscriptions           | Plans with immutable versions, validated features/limits, trial on approval, payment/renewal, plan change, admin suspend/reactivate/expire, configurable grace (default 3 days), append-only history, 15-minute lifecycle sweep job, central enforcement, billing seam |
| Marketplace             | Pure eligibility rules with reasons, clinic visibility preferences, public clinic/doctor endpoints with allow-listed fields                                                                                                                                            |
| Cross-cutting           | Shared state machine helper; transactional outbox; audit events for every sensitive change                                                                                                                                                                             |

## B. Database changes

25 forward-only, additive migrations (`20261111150001`–`20261111150025`) with **23 new tables**
and **4 extended tables** (`clinics`, `clinic_branches`, `doctor_profiles`, `clinic_memberships`),
plus 12 new permissions with their role grants. Composite clinic-scoped FKs, CHECK constraints
on every status, and generated-column unique keys enforce one open suspension, closure or
transfer per clinic. Details: [PLATFORM_DATABASE_SCHEMA.md](../database/PLATFORM_DATABASE_SCHEMA.md).

## C. API inventory

**105 endpoints** under `/api/v1`: registration 17, clinics/branches/lifecycle 28, ownership
transfer 15, doctor profiles 12, staff/invitations 10, subscriptions/plans/settings 18,
marketplace 5. The full list with permissions is in [PLATFORM_API.md](../api/PLATFORM_API.md).

## D. Business rules

All workflows are documented with their state machines and rules in:
[CLINIC_REGISTRATION](../platform/CLINIC_REGISTRATION.md) · [CLINIC_LIFECYCLE](../platform/CLINIC_LIFECYCLE.md) ·
[BRANCH_MANAGEMENT](../platform/BRANCH_MANAGEMENT.md) · [DOCTOR_PROFILES](../platform/DOCTOR_PROFILES.md) ·
[CLINIC_MEMBERSHIPS](../platform/CLINIC_MEMBERSHIPS.md) · [OWNERSHIP_TRANSFER](../platform/OWNERSHIP_TRANSFER.md) ·
[SUBSCRIPTION_MANAGEMENT](../platform/SUBSCRIPTION_MANAGEMENT.md) · [MARKETPLACE_ELIGIBILITY](../platform/MARKETPLACE_ELIGIBILITY.md).

## E. Security review

See [PLATFORM_AUTHORIZATION.md](../platform/PLATFORM_AUTHORIZATION.md); each of the 12 security
requirements is mapped to its enforcement and test. Highlights:

- services authorize themselves;
- clinic-scoped repositories use `ClinicScope` and `tenantExecutor`;
- foreign ids return 404;
- no self-approval anywhere (registration, closure, verification, transfer);
- invitations are the only clinic-side membership path;
- the last-owner guard and the transfer swap are serialized by clinic row locks;
- private documents are served only after authorization, with downloads audited;
- tokens, hashes and documents never appear in logs, audit or outbox payloads.

## F. Testing results (all executed; none failed, none skipped)

| Command                                                                                   | Result                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` (unit)                                                                         | ✅ 20 files, **204 passed** (90 new for Task 03)                                                                                                                    |
| `npm run test:integration` (all, real MySQL 8.4 + Redis 7.4)                              | ✅ 18 files, **181 passed**                                                                                                                                         |
| `npm run test:platform` (Task 03)                                                         | ✅ **61 passed** (registration 9, lifecycle 9, branches + tenant isolation 7, staff/invitations 11, ownership 7, doctor profiles 7, subscriptions 6, marketplace 5) |
| `npm run test:auth` / `test:authorization` / `test:tenant` / `test:security` / `test:api` | ✅ 29 / 26 / 13 / 20 / 11 passed (Task 02 regression)                                                                                                               |

Mandatory security and tenant-isolation cases, all covered:

- **Cross-clinic access:** A cannot read or modify B's branches, or manage B's members,
  invitations or closures.
- **Escalation:** a manager cannot promote themselves or touch owners; a doctor cannot grant
  themselves permissions.
- **Manipulated ids:** manipulated document and request ids are rejected.
- **Self-approval and bypass:** self-approval of a registration is blocked; the Super Admin
  step of an ownership transfer cannot be bypassed.
- **Removal from one clinic** keeps the person's other memberships.
- **Invitations:** expired, revoked and used invitations are rejected.
- **Subscription bypass:** blocked via both probe and real endpoints.
- **Suspended and closed clinics** are restricted.
- **Concurrency:** a mutual-owner-removal race and parallel transfer approvals.

During verification I fixed test defects (expectations, a refresh-token-aware clock helper,
approval reasons below the 3-character minimum) and these product bugs:

- a deadlock in the expired-invitation path;
- `DATE` columns converted with `String(Date)` instead of `YYYY-MM-DD`;
- an admin settings read that wrote an audit event.

## G. Build and quality results

| Command                                       | Result                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm ci` (clean)                              | ✅                                                                                                                                                                                         |
| `npm run format:check` / `lint` / `typecheck` | ✅ / ✅ 0 errors / ✅                                                                                                                                                                      |
| `npm run build`                               | ✅                                                                                                                                                                                         |
| Migrations                                    | ✅ 45 applied on the dev DB (container) and the test DB (global setup)                                                                                                                     |
| `docker compose config` (default + worker)    | ✅ valid                                                                                                                                                                                   |
| Docker smoke                                  | ✅ backend healthy; `/plans`, `/specialties`, `/public/clinics` 200; `/clinic` 401 without auth; worker started with queue `subscription-lifecycle` and its scheduler key present in Redis |
| `npm audit --omit=dev`                        | ✅ 0 vulnerabilities (dev-only ESLint advisory unchanged)                                                                                                                                  |

## H. Documentation

- **Created** (all 12 required): `docs/architecture/PLATFORM_ARCHITECTURE.md`, `CLINIC_REGISTRATION.md`,
  `CLINIC_LIFECYCLE.md`, `BRANCH_MANAGEMENT.md`, `DOCTOR_PROFILES.md`, `CLINIC_MEMBERSHIPS.md`,
  `OWNERSHIP_TRANSFER.md`, `SUBSCRIPTION_MANAGEMENT.md`, `MARKETPLACE_ELIGIBILITY.md`,
  `PLATFORM_API.md`, `PLATFORM_DATABASE_SCHEMA.md`, `PLATFORM_AUTHORIZATION.md`.
- **Updated:** `docs/architecture/decisions/DECISIONS.md` (ADR-025 to ADR-034, OD-13 to OD-18),
  `docs/architecture/ARCHITECTURE.md`, `docs/development/ENVIRONMENT_SETUP.md`,
  `docs/development/TESTING_GUIDELINES.md`, `README.md`, and this report plus the task index.

## I. Known issues and limitations

- **Production is blocked by design** until R2 private storage (OD-13) and a real OTP provider
  (OD-06) are integrated.
- **No payment gateway:** payments are recorded by Super Admins (OD-16). No notification
  delivery: invitation tokens are returned to the inviter (OD-15), and outbox events have no
  publisher yet.
- **Required closure actions are confirmed manually** until the bookings and queue modules
  register detectors. The outstanding-responsibility hook returns nothing yet.
- **Public listings** evaluate subscription standing per clinic in code (a bounded N+1 on pages
  of ≤ 100); a page may contain fewer items than `limit`.
- **Not yet built:** profile image upload and public media; clinic name and legal identity
  changes (OD-18); a 2FA reset (OD-11); retention and cleanup jobs.
- **Per-request overhead:** each clinic permission check adds ~3–4 indexed queries (no cache,
  by design for immediate effect).

## J. Blueprint deviations

1. **Private storage:** an interface plus a dev-only local provider instead of R2 (R2 is not
   integrated yet).
2. **Operation categories and MEMBER level** added to the permission catalog (approved roles
   unchanged; 12 new permissions).
3. **Interpretations needing approval:**
   - the registration `SUSPENDED` meaning (ADR-027);
   - the operating policy matrix (ADR-026);
   - approval creates the main branch and the subscription (ADR-028);
   - the previous owner loses all roles in the transferred clinic (ADR-031).

   _Task 03.1: ADR-027, ADR-028 and ADR-031 were confirmed and documented in detail. ADR-026
   remains open for approval. See [TASK_03_1_REPORT.md](TASK_03_1_REPORT.md)._

4. **Error code change:** the membership transition error code changed from
   `INVALID_MEMBERSHIP_TRANSITION` to the uniform `INVALID_TRANSITION`. Task 02 exposed no
   HTTP endpoint with the old code; one Task 02 test was updated, plus one for the two new
   receptionist read permissions.
5. **Specialty catalog** management uses `platform.doctors.verify` (no separate permission).
   _Superseded by Task 03.1: now `platform.specialties.manage` (ADR-035)._

## K. Manual verification still recommended

- Upload and download real PDF/JPEG files through the Docker backend (local storage path and
  permissions in the container).
- Let the worker's 15-minute sweep run on a dev clinic with an expired trial.
- Review public endpoint payloads with product and legal owners (fields considered public).
- Walk through a full closure with the operations team (required-action wording).
- Run concurrent ownership-transfer approvals from two real admin browsers.

## L. Readiness assessment

**Complete** within the defined scope. Every requested workflow, API, audit event, migration,
document and test category is implemented, and every check above was executed and passed.
Production readiness additionally requires the open integrations (R2, OTP provider, payment
gateway, notifications) and approval of the flagged decisions. Task 04 was not started.
