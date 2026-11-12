# Clinic setup API: doctors, services, branch hours, schedules (`/api/v1`)

> **Purpose:** endpoint reference for Task 04: method, path, permission, behaviour and examples.
> Conventions are those of [PLATFORM_API.md](PLATFORM_API.md): `{ data }` envelopes, keyset
> pagination `{ data, page: { limit, nextCursor } }` (`limit` ≤ 100, `cursor`), errors
> `{ error: { code, message, requestId, details? } }`. All endpoints need `Authorization` and
> `X-Clinic-Id`.

**Path branch ids are not context.** For every route with a branch in the path, or a resource
that belongs to a branch, the branch is re-resolved against the caller's memberships. A branch
the caller does not cover, or a resource of another clinic, is `404`. Ids are strings.

## Doctor branch assignments

| Method & path                                                         | Permission                                             | Notes                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| GET `/clinic/branches/:branchId/doctors?status&limit&cursor`          | `clinic.schedules.view` (branch)                       | paginated                                                         |
| POST `/clinic/branches/:branchId/doctors` `{membershipId, notes?}`    | `clinic.doctors.manage`                                | 201; `422 DOCTOR_NOT_ELIGIBLE {reasons}`, `409 ASSIGNMENT_EXISTS` |
| GET `/clinic/doctors/:membershipId/branches?status`                   | `clinic.schedules.view` (filtered to visible branches) | a doctor's branches                                               |
| GET `/clinic/me/doctor-assignments`                                   | any member                                             | caller's own                                                      |
| GET `/clinic/doctor-assignments/:assignmentId`                        | `clinic.schedules.view` (branch)                       |                                                                   |
| PATCH `/clinic/doctor-assignments/:assignmentId` `{notes}`            | `clinic.doctors.manage`                                | active only                                                       |
| POST `/clinic/doctor-assignments/:assignmentId/deactivate` `{reason}` | `clinic.doctors.manage`                                | ends active schedules and service assignments                     |

```jsonc
// POST /clinic/branches/12/doctors  { "membershipId": "57" }  → 201
{ "data": {
  "id": "31", "branch": { "id": "12", "name": "Main", "timeZone": "Africa/Cairo", "status": "ACTIVE" },
  "membershipId": "57",
  "doctor": { "profileId": "9", "displayName": "Dr. Synthetic Example", "verificationStatus": "VERIFIED" },
  "status": "ACTIVE", "notes": null, "effective": true, "blockers": [],
  "createdAt": "2026-11-11T19:20:00.000Z", "deactivatedAt": null, "deactivationReason": null } }

// 422
{ "error": { "code": "DOCTOR_NOT_ELIGIBLE", "message": "The doctor cannot be assigned to this branch",
  "details": { "reasons": ["DOCTOR_NOT_VERIFIED"] }, "requestId": "…" } }
```

## Services and branch offerings

| Method & path                                                           | Permission                      | Notes                                            |
| ----------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| GET `/clinic/services?status&specialty&limit&cursor`                    | `clinic.services.view`          | paginated                                        |
| POST `/clinic/services`                                                 | `clinic.services.manage`        | 201; `nameEn` or `nameAr` required               |
| GET / PATCH `/clinic/services/:serviceId`                               | view / manage                   | PATCH may set `status`                           |
| GET `/clinic/branches/:branchId/services?status&serviceId&limit&cursor` | `clinic.services.view` + branch | paginated                                        |
| GET `/clinic/branches/:branchId/services/:serviceId`                    | `clinic.services.view` + branch |                                                  |
| PUT `/clinic/branches/:branchId/services/:serviceId`                    | `clinic.services.manage`        | **idempotent upsert**; 201 created / 200 updated |
| GET `/clinic/branches/:branchId/services/:serviceId/doctors`            | `clinic.services.view` + branch | active doctor eligibilities                      |

```jsonc
// POST /clinic/services
{ "code": "cardio_consult", "nameEn": "Cardiology consultation", "nameAr": "كشف قلب",
  "descriptionEn": "First visit", "preparationEn": "Bring previous ECGs", "specialtyCode": "cardiology" }

// PUT /clinic/branches/12/services/40
{ "priceMinor": 30000, "durationMinutes": 20, "bufferMinutes": 5, "instructionsAr": "الحضور قبل الموعد بعشر دقائق" }
// → 201
{ "data": { "id": "70", "branchId": "12",
  "service": { "id": "40", "name": { "en": "Cardiology consultation", "ar": "كشف قلب" }, "status": "ACTIVE", "specialtyCode": "cardiology" },
  "status": "ACTIVE", "available": true, "price": { "amountMinor": 30000, "currency": "EGP" },
  "durationMinutes": 20, "bufferMinutes": 5, "instructions": { "en": null, "ar": "الحضور قبل الموعد بعشر دقائق" },
  "updatedAt": "…" } }
```

Errors: `UNKNOWN_SPECIALTY` (422), `CONFLICT` (duplicate code), `SERVICE_INACTIVE` (409).

## Doctor ↔ service

| Method & path                                                                                        | Permission                      | Notes                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| GET `/clinic/doctor-assignments/:assignmentId/services?status`                                       | `clinic.services.view` + branch |                                                                         |
| PUT `/clinic/doctor-assignments/:assignmentId/services/:serviceId` `{durationMinutes?, priceMinor?}` | `clinic.doctors.manage`         | idempotent; 201/200; service must be offered at the assignment's branch |
| DELETE `/clinic/doctor-assignments/:assignmentId/services/:serviceId`                                | `clinic.doctors.manage`         | 204; ends (history kept)                                                |

Errors: `404` (not offered at this branch), `409 OFFERING_NOT_AVAILABLE`, `409 ASSIGNMENT_NOT_ELIGIBLE`.

## Branch operating hours, doctor schedules, exceptions

| Method & path                                                                   | Permission                |
| ------------------------------------------------------------------------------- | ------------------------- |
| GET / POST `/clinic/branches/:branchId/hours`                                   | schedules view / manage   |
| GET `/clinic/branches/:branchId/opening-time?from&to` (≤ 62 days)               | `clinic.schedules.view`   |
| GET / POST `/clinic/branches/:branchId/exceptions?status&from&to`               | schedules view / manage   |
| GET / POST `/clinic/doctor-assignments/:assignmentId/schedules`                 | schedules view / manage   |
| GET / POST `/clinic/doctor-assignments/:assignmentId/exceptions`                | schedules view / manage   |
| GET `/clinic/doctor-assignments/:assignmentId/working-time?from&to` (≤ 62 days) | `clinic.schedules.view`   |
| GET `/clinic/schedules/:scheduleId`                                             | `clinic.schedules.view`   |
| POST `/clinic/schedules/:scheduleId/revisions` (schedule body)                  | `clinic.schedules.manage` |
| POST `/clinic/schedules/:scheduleId/deactivate` `{reason}`                      | `clinic.schedules.manage` |
| POST `/clinic/schedules/:scheduleId/activate`                                   | `clinic.schedules.manage` |
| POST `/clinic/schedule-exceptions/:exceptionId/cancel`                          | `clinic.schedules.manage` |

```jsonc
// POST /clinic/doctor-assignments/31/schedules  → 201
{ "effectiveFrom": "2026-11-15", "effectiveUntil": null, "note": "Winter timetable",
  "periods": [
    { "day": "SUN", "start": "09:00", "end": "13:00" },
    { "day": "SUN", "kind": "BREAK", "start": "11:00", "end": "11:30" },
    { "day": "TUE", "start": "16:00", "end": "20:00" } ] }

// POST /clinic/doctor-assignments/31/exceptions
{ "kind": "CLOSED", "startDate": "2026-12-20", "endDate": "2026-12-27", "reason": "Annual leave" }
{ "kind": "EXTRA", "startDate": "2026-12-03", "start": "17:00", "end": "19:00", "reason": "Extra clinic" }

// GET /clinic/doctor-assignments/31/working-time?from=2026-11-15&to=2026-11-15
{ "data": { "assignmentId": "31", "branchId": "12", "timeZone": "Africa/Cairo", "effective": true, "blockers": [],
  "days": [ { "date": "2026-11-15",
    "local": [ { "start": "09:00", "end": "11:00" }, { "start": "11:30", "end": "13:00" } ],
    "utc":   [ { "startsAt": "2026-11-15T07:00:00.000Z", "endsAt": "2026-11-15T09:00:00.000Z" },
               { "startsAt": "2026-11-15T09:30:00.000Z", "endsAt": "2026-11-15T11:00:00.000Z" } ] } ] } }
```

Schedule errors (409 unless noted): `VALIDATION_ERROR` (400; periods, past dates),
`SCHEDULE_OVERLAP`, `BRANCH_HOURS_NOT_COVERED {gaps}`,
`OUTSIDE_BRANCH_HOURS {outside}`,
`DOCTOR_SCHEDULE_CONFLICT {branchId, assignmentId, startsAt, endsAt}`,
`BRANCH_HOURS_IN_USE {schedules}`, `EXCEPTION_OVERLAP`, `ASSIGNMENT_NOT_ELIGIBLE {blockers}`,
and `BRANCH_TIME_ZONE_LOCKED` (on `PATCH /clinic/branches/:id`).

## Operating state

Writes are **ADMINISTRATION** and get `403 CLINIC_SUSPENDED` / `CLINIC_CLOSED` under a FULL
suspension or closure. They stay allowed under a NEW_OPERATIONS suspension and a restricted
subscription (ADR-026). Reads are CLINIC_INFO and are always available to members holding the
view permission.
