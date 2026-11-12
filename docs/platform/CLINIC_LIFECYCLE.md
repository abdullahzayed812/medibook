# Clinic lifecycle

> **Purpose:** the operational status of an approved clinic (suspension, closure) and the
> central operating policy. Operational status is independent of the registration status and
> the subscription status. See
> [CLINIC_REGISTRATION.md](CLINIC_REGISTRATION.md#three-independent-status-dimensions).

## Operational status

```
ACTIVE ⇄ SUSPENDED      (suspend / formal reinstatement)
ACTIVE | SUSPENDED → CLOSING → CLOSED   (closure approval / completion; CLOSED is final)
```

All changes are made by dedicated services, under a clinic row lock, with
`clinic_lifecycle_history`, audit and outbox (`clinic.suspended`, `clinic.active`,
`clinic.closing`, `clinic.closed`). Nothing is deleted.

## Operating policy (central; `operation-policy.ts`)

| State                       | CLINIC_INFO |   READ    | CONTINUITY_OF_CARE | ADMINISTRATION | NEW_OPERATION | LIFECYCLE |
| --------------------------- | :---------: | :-------: | :----------------: | :------------: | :-----------: | :-------: |
| ACTIVE                      |     ✅      |    ✅     |         ✅         |       ✅       |      ✅       |    ✅     |
| Suspension `NEW_OPERATIONS` |     ✅      |    ✅     |         ✅         |       ✅       |      ❌       |    ✅     |
| Suspension `FULL`           |     ✅      | exception |     exception      |       ❌       |      ❌       |    ✅     |
| CLOSING                     |     ✅      |    ✅     |         ✅         |       ✅       |      ❌       |    ✅     |
| CLOSED                      |     ✅      |    ✅     |         ❌         |       ❌       |      ❌       |    ❌     |
| Subscription restricted     |     ✅      |    ✅     |         ✅         |       ✅       |      ❌       |    ✅     |
| Selected branch INACTIVE    |     ✅      |    ✅     |         ✅         |       ✅       |      ❌       |    ✅     |

Rules combine, and the most restrictive applies. Error codes: `CLINIC_SUSPENDED`,
`CLINIC_CLOSING`, `CLINIC_CLOSED`, `SUBSCRIPTION_INACTIVE`, `BRANCH_INACTIVE` (all 403).
The matrix is unit-tested cell by cell (`operation-policy.test.ts`) and exercised end to end
through the real middleware (`clinic-lifecycle`, `subscriptions` integration suites). ADR-026
records it; it was verified against the implementation in Task 03.2.

**Where it is enforced:** `AuthorizationService.check` first evaluates the membership and role
(`evaluateClinicPermission`). Only if that allows does it call the injected
`ClinicOperationGate`, which re-reads the clinic, its open suspension, the effective
subscription and the selected branch from MySQL on every check (no cache). Every clinic
permission check therefore passes through the gate, including the inviter re-check during
invitation acceptance. Super Admin platform actions (`platform.*`) are not clinic permissions
and are not gated. Growth limits (`assertCanGrow`) additionally require a subscription in good
standing.

**Order of evaluation** (first match wins): CLINIC_INFO is always allowed → CLOSED (READ only) →
FULL suspension (LIFECYCLE always; READ and CONTINUITY_OF_CARE only with an exception) → for
NEW_OPERATION only: NEW_OPERATIONS suspension → CLOSING → subscription → inactive branch.

## Temporary suspension (Super Admin, `platform.clinics.manage`)

- Input: scope (`FULL` or `NEW_OPERATIONS`), reason, optional expected end. Start time and
  the responsible admin are recorded. At most one open suspension exists per clinic (a
  generated-column unique key).
- Memberships and data are untouched; members keep their accounts and other clinics.
- The clinic's operational status becomes SUSPENDED. The **registration status (APPROVED) and the
  subscription status do not change** (tested), and nothing about the subscription is paused or
  extended.

### FULL vs NEW_OPERATIONS

| Operation category                                              | `NEW_OPERATIONS` suspension      | `FULL` suspension                                                               |
| --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------- |
| CLINIC_INFO (clinic profile, branches, subscription view)       | available                        | available                                                                       |
| READ (patients, bookings, reports, exports)                     | available                        | **blocked**, unless the user has an exception                                   |
| CONTINUITY_OF_CARE (queue, records, prescriptions, payments)    | available                        | **blocked**, unless the user has an exception                                   |
| ADMINISTRATION (settings, staff, branches, services, schedules) | available                        | **blocked** (exceptions never unlock it)                                        |
| NEW_OPERATION (new patients, new bookings)                      | **blocked** (`CLINIC_SUSPENDED`) | **blocked**                                                                     |
| LIFECYCLE (closure request, ownership transfer)                 | available                        | available                                                                       |
| Growth (new branch, invitations)                                | available (plan limits apply)    | blocked (an ADMINISTRATION action)                                              |
| Accepting a pending invitation                                  | available                        | fails (`INVITATION_INVALID`): the inviter's re-check is an ADMINISTRATION check |

`NEW_OPERATIONS` is the lighter measure: the clinic keeps working with existing patients and can
administer itself, but takes on no new work. `FULL` stops everything except clinic information
and lifecycle actions; care for existing patients continues only through exceptions.

### Continuity-of-care exceptions (FULL scope only)

| Rule         | Implementation                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Who grants   | a Super Admin with `platform.clinics.manage` and an MFA-verified session                                              |
| Not for self | a Super Admin who is also a member cannot grant one to themselves (`403 SELF_APPROVAL_FORBIDDEN`, Task 03.2)          |
| Who receives | one user with an **ACTIVE membership** in that clinic (`409` otherwise). An exception never creates access.           |
| When         | only while a **FULL** suspension is open (`409` for NEW_OPERATIONS or no suspension)                                  |
| Bound to     | that specific suspension: after reinstatement it is void, even if the clinic is suspended again (tested)              |
| Duration     | starts now, mandatory expiry in the future and ≤ `access_exception.max_duration_hours` (default 72)                   |
| Effect       | unlocks READ and CONTINUITY_OF_CARE for that user only, and only within what their roles already permit               |
| Revocation   | `POST /admin/clinics/:id/access-exceptions/:exceptionId/revoke`; effective on the next request (tested)               |
| Audit        | `ACCESS_EXCEPTION_GRANTED` (user, reason, expiry, suspension) and `ACCESS_EXCEPTION_REVOKED`, in the same transaction |
| Evaluation   | checked on every request (`revoked_at IS NULL AND starts_at <= now < expires_at`), so expiry needs no job             |

No general bypass exists.

- **Reinstatement** ends the suspension (who, when, why). SUSPENDED → ACTIVE; a CLOSING clinic
  stays CLOSING.

## Permanent closure

1. **Owner request** (`clinic.lifecycle.manage`): reason and optional effective date. One open
   request per clinic; the owner can cancel while it awaits review.
2. **Super Admin decision**: reject (the clinic stays as it was) or approve. Approval moves the
   clinic to CLOSING, stops new operations, removes it from Marketplace eligibility, revokes
   pending invitations, cancels open ownership transfers, emits `clinic.closing` (the patient
   notification integration point) and creates the **required actions**:
   ACTIVE_BOOKINGS, OPEN_QUEUE_AND_CASES, PATIENT_NOTIFICATION, MEDICAL_RECORDS_RETENTION,
   FINANCIAL_RECORDS, MEMBERSHIPS_AND_ADMIN_TASKS.
3. **Resolution**: the owner resolves actions with a note; a Super Admin may resolve or waive.
   Future modules (bookings, queue) add automatically detected actions through
   `ClosureActionProvider`. No clinical workflow is invented here.
4. **Completion** (Super Admin): refused with `409 CLOSURE_BLOCKED` while any action is open.
   Otherwise the clinic becomes CLOSED, the subscription EXPIRED, any open suspension ends, and
   `clinic.closed` is emitted.

After closure, records, memberships and history remain. Members keep READ access (for record
retention and export), and everything else is blocked. Membership handling after closure is
an owner action (open decision OD-17).
