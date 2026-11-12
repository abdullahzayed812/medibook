# Doctor branch assignments

> **Purpose:** how a doctor (one global profile, possibly several clinics) is assigned to the
> branches of one clinic, which rules decide eligibility, and how the assignment relates to
> membership, verification and branch status. Decision: ADR-040.
> Related: [DOCTOR_PROFILES.md](DOCTOR_PROFILES.md) · [CLINIC_MEMBERSHIPS.md](CLINIC_MEMBERSHIPS.md) ·
> [SCHEDULES.md](SCHEDULES.md) · [SERVICE_CATALOG.md](SERVICE_CATALOG.md).

## Layers

| Layer                              | Owned by                             | Says                                                                  |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Global doctor profile              | the doctor, verified by the platform | who the doctor is; VERIFIED or not                                    |
| DOCTOR clinic membership           | the clinic (Task 02/03)              | the doctor may access this clinic, and which branches (`branchScope`) |
| **Doctor branch assignment** (new) | the clinic                           | the doctor _works_ at this branch (services, schedules hang off it)   |

Membership branch coverage is **access** ("may see branch X data"). An assignment is a
**working arrangement**. An assignment requires coverage, but coverage alone does not create
an assignment. A doctor can be assigned to several branches of the same clinic, each with its
own services, schedules and notes.

## Eligibility (checked in the transaction, after the clinic lock)

To create an assignment, all must hold (otherwise `422 DOCTOR_NOT_ELIGIBLE` with `reasons`):

- the membership belongs to this clinic (otherwise `404`), and its role is `DOCTOR`
  (`NOT_A_DOCTOR_MEMBERSHIP`);
- it is ACTIVE and inside its effective window (`MEMBERSHIP_INACTIVE`);
- it covers the branch: scope ALL, or the branch is assigned (`BRANCH_NOT_COVERED`);
- the user has a global doctor profile (`NO_DOCTOR_PROFILE`) that is `VERIFIED`
  (`DOCTOR_NOT_VERIFIED`) and `ACTIVE` (`DOCTOR_PROFILE_INACTIVE`);
- the branch belongs to this clinic (otherwise `404`);
- no ACTIVE assignment exists for this membership and branch (`409 ASSIGNMENT_EXISTS`). This is
  enforced by the clinic lock and by a unique key on a generated `active_key` column.

## Independence and `effective`

Statuses are not copied or cascaded between layers. Every read recomputes:

```
effective = assignment ACTIVE ∧ membership ACTIVE (in window) ∧ membership covers the branch
            ∧ profile VERIFIED ∧ profile ACTIVE ∧ branch ACTIVE
```

The view returns `effective` and `blockers` (`ASSIGNMENT_INACTIVE`, `MEMBERSHIP_INACTIVE`,
`BRANCH_NOT_COVERED`, `DOCTOR_NOT_VERIFIED`, `DOCTOR_PROFILE_INACTIVE`, `BRANCH_INACTIVE`).

- Terminating or suspending the membership, or suspending the doctor's verification, makes the
  assignment ineffective immediately. Its working time becomes empty and no configuration can
  be added (`409 ASSIGNMENT_NOT_ELIGIBLE`). The assignment row and its history stay unchanged
  (tested). Whether termination should also end assignments automatically is OD-23.
- An inactive branch blocks `effective`, but not configuration (ADR-026: only new operations).
- Memberships in other clinics and the global profile are never touched.

## Deactivation

`POST …/deactivate { reason }` sets the assignment INACTIVE (who, when, why). In the same
transaction, its active schedules are deactivated (`ASSIGNMENT_DEACTIVATED`) and its active
service assignments are ended. Nothing is deleted. A later re-assignment creates a **new** row,
and the old one remains as history.

## Authorization

| Action                              | Permission                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| Assign, edit notes, deactivate      | `clinic.doctors.manage` (CLINIC level: owner, all-branch manager) |
| View by branch, by doctor, single   | `clinic.schedules.view` for the assignment's branch               |
| `GET /clinic/me/doctor-assignments` | any member (`clinic.profile.view`); returns only the caller's own |

Branch-assigned staff see only assignments of branches they cover. Others are `404`, and the
by-doctor list is filtered. Every change is audited (`DOCTOR_ASSIGNMENT_CREATED` / `_CHANGED`)
with an outbox event (`doctor_assignment.*`).
