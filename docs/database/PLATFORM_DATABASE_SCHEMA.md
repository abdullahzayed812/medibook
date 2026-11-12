# Platform database schema (Task 03)

> **Purpose:** table-by-table reference for the platform and clinic management schema.

Migrations `20261111150001`–`20261111150025` are **additive**: no Task 02 data is modified or
dropped. All new tables use InnoDB, `utf8mb4_0900_ai_ci`, UTC `DATETIME(3)` and explicit
`ON DELETE` behaviour (`RESTRICT` for business data, `CASCADE` only for pure child rows, and
`SET NULL` for optional actor references).

| Migration                                                 | Change                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 150001 `platform_settings`                                | key → JSON value overrides (defaults in code)                                                                                  |
| 150002 `domain_events`                                    | transactional outbox; index `(published_at, id)`                                                                               |
| 150003 extend `clinics`                                   | profile, address, coordinates (range CHECKs), legal identity, `operational_status` (CHECK), `approved_at/by`, visibility flags |
| 150004 extend `clinic_branches`                           | address, coordinates, contacts, `time_zone`, `status` (CHECK), `settings` JSON                                                 |
| 150005 `clinic_registration_requests`                     | status CHECK; `clinic_id` UNIQUE and only allowed when APPROVED (CHECK)                                                        |
| 150006 `clinic_registration_review_history`               | append-only                                                                                                                    |
| 150007 `clinic_registration_documents`                    | document metadata; `storage_key` UNIQUE; type and content-type CHECKs                                                          |
| 150008 `clinic_lifecycle_history`                         | append-only operational history                                                                                                |
| 150009 `clinic_suspensions`                               | scope CHECK; **one open suspension per clinic** via a generated `open_key` + UNIQUE; `UNIQUE (clinic_id, id)`                  |
| 150010 `clinic_access_exceptions`                         | FK `(clinic_id, suspension_id)` → suspensions (cannot point at another clinic's suspension)                                    |
| 150011 `clinic_closure_requests`                          | status CHECK; one open request per clinic (generated `open_key`)                                                               |
| 150012 `clinic_closure_actions`                           | FK `(clinic_id, closure_request_id)`; UNIQUE `(request, action_type)`                                                          |
| 150013 `clinic_ownership_transfers`                       | parties CHECK (`from ≠ to`); one open transfer per clinic (generated `open_key`); identity verification columns                |
| 150014 `clinic_ownership_transfer_history`                | append-only                                                                                                                    |
| 150015 `ownership_transfer_documents`                     | document metadata                                                                                                              |
| 150016 extend `doctor_profiles`                           | bio, qualifications JSON, license data, image key, visibility, `verification_status` + `profile_status` CHECKs                 |
| 150017 `specialties`, `doctor_specialties`                | catalog (code CHECK) + link table                                                                                              |
| 150018 `doctor_verification_documents`                    | document metadata                                                                                                              |
| 150019 `doctor_verification_history`                      | append-only                                                                                                                    |
| 150020 extend `clinic_memberships`                        | adds `INACTIVE` to the status CHECK; `public_listing` (CHECK: doctors only)                                                    |
| 150021 `clinic_invitations`, `clinic_invitation_branches` | token hash UNIQUE; role CHECK excludes CLINIC_OWNER; composite FKs `(clinic_id, branch_id)` and `(membership_id, clinic_id)`   |
| 150022 `subscription_plans`, `subscription_plan_versions` | immutable versions; UNIQUE `(plan_id, version)`; plan → current version via composite FK `(id, current_version_id)`            |
| 150023 `clinic_subscriptions`                             | one per clinic (UNIQUE); FK `(plan_id, plan_version_id)` (the version must belong to the plan); status/cycle/grace CHECKs      |
| 150024 `clinic_subscription_history`                      | append-only                                                                                                                    |
| 150025 permissions                                        | 13 new permissions + role grants (no existing grant changed); `platform.specialties.manage` added in Task 03.1                 |

## Consistency notes

- **No redundant derived status.** Effective subscription status, marketplace eligibility and
  the clinic owner are computed (from dates, flags and memberships), never stored twice.
  Stored subscription status is advanced by explicit events and the idempotent sweep;
  enforcement derives from dates (SUBSCRIPTION_MANAGEMENT.md).
- **"At most one open X per clinic" invariants** are enforced by a clinic row lock in the service
  **and** by generated-column unique keys in the schema.
- **Cross-tenant links** are impossible wherever two clinic-scoped rows relate: composite FKs
  carry `clinic_id`.
- **Rollback strategy:** migrations are forward-only (ADR-007). Every Task 03 migration is
  additive, so rolling back application code needs no schema rollback. A faulty migration is
  fixed with a new one.
