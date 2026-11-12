# Branch management

> **Purpose:** branch fields, rules, status and limits within a clinic.

A clinic has one or more branches. The main branch is created at approval.

| Field                                                                       | Notes                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------- |
| name, address lines, city, region, postal code, country, latitude/longitude | coordinates range-checked                           |
| contact phone (E.164), contact email                                        |                                                     |
| time zone                                                                   | IANA name, validated (`Intl`)                       |
| status                                                                      | ACTIVE / INACTIVE                                   |
| settings                                                                    | small JSON object of scalar administrative settings |

## Operations

| Endpoint                                                                                      | Permission                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `GET /clinic/branches`, `GET /clinic/branches/:id`                                            | `clinic.branches.view` (MEMBER level)          |
| `POST /clinic/branches`, `PATCH /clinic/branches/:id`, `POST …/activate`, `POST …/deactivate` | `clinic.branches.manage` (owner; CLINIC level) |

- Branch rows are clinic-scoped (`ClinicScope` + `tenantExecutor`). Another clinic's branch id
  returns 404.
- **Listing respects assignments:** all-branch members see every branch; branch-assigned members
  see only their branches, and other branches return 404.
- **Operational access** to a branch still requires `X-Branch-Id` coverage (Task 02 rule).
  An assignment never adds permissions beyond the role.
- Creating or reactivating a branch checks the subscription standing and the plan limit
  `max_branches` (`PLAN_LIMIT_REACHED`). Checks are serialized per clinic.
- An **INACTIVE branch** blocks NEW_OPERATION in that branch context. Reads and continuity
  of care continue.
- Managers do not hold `clinic.branches.manage` in the approved Task 02 mapping. Granting it
  is a mapping change (open decision OD-14).
- Schedules and availability are out of scope (Task 04).
