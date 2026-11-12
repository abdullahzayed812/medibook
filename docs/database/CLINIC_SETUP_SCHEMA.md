# Clinic setup schema (Task 04)

> **Purpose:** table-by-table reference for doctor assignments, services, offerings and
> schedules. Migrations `20261111160001`–`20261111160007` are new, forward-only files; no
> earlier migration was changed. Conventions: InnoDB, `utf8mb4_0900_ai_ci`, `BIGINT UNSIGNED`
> ids, UTC `DATETIME(3)`, explicit `ON DELETE`, every clinic-owned table has `clinic_id`.
> Related: [PLATFORM_DATABASE_SCHEMA.md](PLATFORM_DATABASE_SCHEMA.md) ·
> [DATABASE_MIGRATIONS.md](../development/DATABASE_MIGRATIONS.md).

| Migration                              | Table(s)                                                                       | Key constraints                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 160001 `doctor_branch_assignments`     | assignment of a DOCTOR membership + doctor profile to a branch                 | FK `(clinic_id, branch_id)` → branches; FK `(membership_id, clinic_id)` → memberships; FK doctor profile; UNIQUE `(clinic_id, branch_id, membership_id, active_key)` with `active_key = IF(status='ACTIVE', 1, NULL)` (one active, many historical); UNIQUE `(clinic_id, branch_id, id)` as composite-FK target; status/deactivation CHECK |
| 160002 `clinic_services`               | clinic service definitions (EN/AR)                                             | UNIQUE `(clinic_id, code)`; FK `specialty_code` → `specialties`; CHECK name EN or AR; code pattern CHECK                                                                                                                                                                                                                                   |
| 160003 `branch_service_offerings`      | service at a branch: price/currency/duration/buffer/instructions               | UNIQUE `(clinic_id, branch_id, service_id)`; FK `(clinic_id, service_id)` → services; FK `(clinic_id, branch_id)` → branches; CHECKs price ≤ 1e9 minor units, currency `^[A-Z]{3}$`, duration 5–720, buffer ≤ 240                                                                                                                          |
| 160004 `doctor_service_assignments`    | doctor eligibility for an offering                                             | FK `(clinic_id, branch_id, assignment_id)` and `(clinic_id, branch_id, offering_id)`, so assignment and offering are in the **same clinic and branch**; UNIQUE active via `active_key`; status/ended CHECK; override CHECKs                                                                                                                |
| 160005 `schedules`, `schedule_periods` | weekly versions (owner BRANCH or DOCTOR) and their periods                     | owner CHECK (`BRANCH` ⇔ `assignment_id IS NULL`); FK `(clinic_id, branch_id, assignment_id)` → assignments (same branch); `effective_until ≥ effective_from`; periods: day 1–7, kind WORK/BREAK, `start < end ≤ 1440`, FK `(clinic_id, schedule_id)`                                                                                       |
| 160006 `schedule_exceptions`           | dated CLOSED / UNAVAILABLE / EXTRA                                             | owner CHECK; kind CHECK (CLOSED = whole days without minutes; others = one date with minutes); status/cancel CHECK                                                                                                                                                                                                                         |
| 160007 permissions                     | `clinic.services.view`, `clinic.schedules.view` + grants to the 4 clinic roles | no existing grant changed                                                                                                                                                                                                                                                                                                                  |

Indexes follow the access paths: `(clinic_id, branch_id, status, id)` for branch lists with
keyset pagination, `(clinic_id, membership_id, status)` for a doctor's branches,
`(clinic_id, branch_id, owner_type, status, effective_from)` and
`(clinic_id, assignment_id, status, effective_from)` for schedule lookups, and
`(clinic_id, …, status, start_date)` for exceptions.

**Storage of time.** `effective_from/until`, `start_date/end_date` are local calendar dates of
the branch. `start_minute/end_minute` are local wall-clock minutes (0–1440) in
`clinic_branches.time_zone`. Audit timestamps are UTC. See [SCHEDULES.md](../platform/SCHEDULES.md).

**History.** No table in this group is ever deleted from by the application. Deactivation,
ending and cancellation set a status plus who/when columns, and schedule periods are
immutable. Integration tests clear these tables between tests (children first; see
`tests/integration/support/harness.ts`).

**Not enforceable by a unique key:** non-overlapping date ranges of active schedule versions,
weekly containment of doctor time in branch time, and cross-branch time conflicts. These are
enforced in the service inside one transaction after the clinic row lock (ADR-034).
