# Platform authorization (Task 03)

> **Purpose:** the permissions and enforcement added for platform and clinic management. It
> extends [AUTHORIZATION.md](../security/AUTHORIZATION.md) and uses the same service, catalog and rules.

## New permissions (migration 150025; existing grants unchanged; 13 since Task 03.1)

| Permission                      | Scope · level · category         | Granted to                           |
| ------------------------------- | -------------------------------- | ------------------------------------ |
| `platform.registrations.review` | PLATFORM                         | SUPER_ADMIN                          |
| `platform.doctors.verify`       | PLATFORM                         | SUPER_ADMIN                          |
| `platform.specialties.manage`   | PLATFORM                         | SUPER_ADMIN                          |
| `platform.plans.manage`         | PLATFORM                         | SUPER_ADMIN                          |
| `platform.subscriptions.manage` | PLATFORM                         | SUPER_ADMIN                          |
| `platform.settings.manage`      | PLATFORM                         | SUPER_ADMIN                          |
| `platform.ownership.review`     | PLATFORM                         | SUPER_ADMIN                          |
| `clinic.profile.view`           | CLINIC · MEMBER · CLINIC_INFO    | owner, manager, doctor, receptionist |
| `clinic.branches.view`          | CLINIC · MEMBER · CLINIC_INFO    | owner, manager, doctor, receptionist |
| `clinic.profile.manage`         | CLINIC · CLINIC · ADMINISTRATION | owner                                |
| `clinic.subscription.view`      | CLINIC · CLINIC · CLINIC_INFO    | owner                                |
| `clinic.marketplace.manage`     | CLINIC · CLINIC · ADMINISTRATION | owner                                |
| `clinic.lifecycle.manage`       | CLINIC · CLINIC · LIFECYCLE      | owner                                |

- **MEMBER level** (new): clinic-wide information visible to any member whose role holds the
  permission, without a branch selection.
- **Operation categories** (new) feed the clinic operation gate (CLINIC_LIFECYCLE.md). Every clinic
  permission has exactly one category.

## Task 04 permissions (migration 160007)

| Permission              | Scope · level · category      | Granted to                           |
| ----------------------- | ----------------------------- | ------------------------------------ |
| `clinic.services.view`  | CLINIC · MEMBER · CLINIC_INFO | owner, manager, doctor, receptionist |
| `clinic.schedules.view` | CLINIC · BRANCH · CLINIC_INFO | owner, manager, doctor, receptionist |

Writes reuse `clinic.doctors.manage`, `clinic.services.manage` (CLINIC level) and
`clinic.schedules.manage` (BRANCH level). See ADR-042 and
[CLINIC_SETUP_API.md](../api/CLINIC_SETUP_API.md).

## Task 05 permissions (migration 170010)

| Permission               | Scope · level · category             | Granted to                   |
| ------------------------ | ------------------------------------ | ---------------------------- |
| `clinic.bookings.cancel` | CLINIC · BRANCH · CONTINUITY_OF_CARE | owner, manager, receptionist |

Confirmation keeps the existing `clinic.bookings.manage` (NEW_OPERATION), and viewing keeps
`clinic.bookings.view` (READ). Patients use the existing `patient.bookings.*` permissions; the
PATIENT role is granted on first use (ADR-045). See [BOOKINGS_API.md](../api/BOOKINGS_API.md).

## How each Task 03 security requirement is enforced

| #   | Requirement                                             | Enforcement                                                            | Test                                                    |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Super Admin operations need explicit global permissions | granular `platform.*` permissions + mandatory MFA                      | every platform suite                                    |
| 2   | Owners manage only their clinics                        | verified `TenantContext`; clinic-scoped repositories                   | `branches-isolation`                                    |
| 3   | Managers only explicitly authorized operations          | role → permission mapping; CLINIC-level perms need ALL scope           | `staff-invitations`, `branches-isolation`               |
| 4   | Doctors cannot grant themselves privileges              | no-self-change rule; assignable-role rules                             | `staff-invitations`                                     |
| 5   | No manipulated clinic or branch ids                     | context verification; `(id, clinic_id)` predicates; 404                | `branches-isolation`                                    |
| 6   | No self-approval of registration                        | `SELF_APPROVAL_FORBIDDEN`                                              | `registration`                                          |
| 7   | Transfers need independent approvals + Super Admin      | recipient-only acceptance; non-party admin; identity + document checks | `ownership-transfer`                                    |
| 8   | No unauthorized membership paths                        | clinic actors: invitations only; direct grants platform-only           | `staff-invitations`                                     |
| 9   | Managers cannot change a doctor's global status         | `platform.doctors.verify` only                                         | `doctor-profiles`                                       |
| 10  | Subscription changes authorized and audited             | `platform.subscriptions.manage`; history + audit + outbox              | `subscriptions`                                         |
| 11  | Private documents in private storage                    | `PrivateObjectStorage`; authorized, audited downloads                  | `registration`, `doctor-profiles`, `ownership-transfer` |
| 12  | No secrets in logs                                      | tokens hashed; never logged, audited or emitted; masked phones         | `staff-invitations`                                     |
| 13  | Catalog curation is not doctor verification (Task 03.1) | `platform.specialties.manage` ≠ `platform.doctors.verify` (ADR-035)    | `specialty-permissions`, unit `permissions.test.ts`     |

Audit records are written in the same transaction as the change (actor, action, target, clinic,
request id, before/after or reason). No API modifies or deletes `audit_events`.
