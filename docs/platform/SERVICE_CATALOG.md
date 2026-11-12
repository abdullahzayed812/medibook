# Clinic services, branch offerings and doctor eligibility

> **Purpose:** the clinic-defined service catalog, how a service is offered at branches with
> branch-specific price and duration, and how doctors are made explicitly eligible for a
> service at a branch. Decision: ADR-040. Related: [DOCTOR_ASSIGNMENTS.md](DOCTOR_ASSIGNMENTS.md) ·
> [CLINIC_SETUP_API.md](../api/CLINIC_SETUP_API.md).

## Three levels

| Level                                | Table                        | Holds                                                                                                              |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Service** (clinic-wide definition) | `clinic_services`            | names and descriptions (EN/AR), preparation instructions (EN/AR), optional specialty, optional clinic code, status |
| **Branch offering**                  | `branch_service_offerings`   | price, currency, duration, buffer, operational instructions (EN/AR), status; one row per (branch, service)         |
| **Doctor ↔ service** at a branch     | `doctor_service_assignments` | which doctor assignment may provide which offering; optional per-doctor duration/price override                    |

- **No mandatory global catalog.** The platform has no canonical service catalog. A service may
  optionally reference a platform **specialty** (`specialties`, which must be active), or be fully
  custom. At least one of `nameEn` / `nameAr` is required.
- `code` is an optional clinic-unique slug (`[a-z0-9_]`). It is useful for imports, and a
  duplicate gets `409`.
- A service can be offered at any number of branches, each with its own price and duration, and
  provided by any number of doctors there.

## Money

- Integer **minor units** (`priceMinor`; for EGP, piastres) plus an ISO 4217 `currency`, the
  same as subscription money (ADR-029). There are no floating-point amounts.
- The currency defaults to the platform setting `clinic.default_currency` (default **EGP**).
  It can be set per offering.
- Ranges: price 0 … 1,000,000,000 minor units; duration 5–720 min; buffer 0–240 min. These are
  enforced by the API schema and by DB CHECKs.
- No payment collection or accounting exists here. Price changes are audited with before/after
  values (OD-24 covers a queryable price history).

## Doctor eligibility (explicit, never inferred)

`PUT /clinic/doctor-assignments/:assignmentId/services/:serviceId` makes the doctor eligible for
that service **at the assignment's branch**. It requires:

- an eligible assignment (see [DOCTOR_ASSIGNMENTS.md](DOCTOR_ASSIGNMENTS.md); `409 ASSIGNMENT_NOT_ELIGIBLE`);
- an offering of that service **at the same branch** (`404` otherwise), with both the offering
  and the service ACTIVE (`409 OFFERING_NOT_AVAILABLE`).

Composite foreign keys `(clinic_id, branch_id, assignment_id)` and
`(clinic_id, branch_id, offering_id)` make a cross-branch or cross-clinic combination impossible
even at the database level. Being assigned to a branch does **not** make a doctor eligible for
its services. The request is idempotent: a repeat updates the overrides (`200`). `DELETE` ends
the row (`ENDED`, kept as history).

Specialty matching between the doctor and the service is **not** enforced (OD-20).

## Deactivation keeps references

Deactivating a service (`PATCH … { status: "INACTIVE" }`) keeps its offerings and doctor
assignments. Views show `available: false`, and new offerings or doctor assignments for it get
`409`. Offerings can be deactivated individually by `PUT … { status: "INACTIVE" }`. Rows are
never deleted.

## Authorization

| Action                                       | Permission                                                         |
| -------------------------------------------- | ------------------------------------------------------------------ |
| View services                                | `clinic.services.view` (MEMBER level; all clinic roles)            |
| View branch offerings / doctors of a service | `clinic.services.view` **and** coverage of that branch             |
| Create/update services, upsert offerings     | `clinic.services.manage` (CLINIC level; owner, all-branch manager) |
| Assign/remove doctor services                | `clinic.doctors.manage` (CLINIC level)                             |

Audit: `SERVICE_CREATED`, `SERVICE_CHANGED`, `SERVICE_OFFERING_CHANGED`,
`DOCTOR_SERVICE_CHANGED`. Outbox payloads carry ids and statuses only, never prices.
