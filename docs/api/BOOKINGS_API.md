# Booking API (`/api/v1`)

> **Purpose:** endpoint reference for the Booking Engine (Task 05): audience, authentication,
> permission, behaviour and examples. Conventions follow [PLATFORM_API.md](PLATFORM_API.md):
> `{ data }` envelopes, keyset pagination `{ data, page: { limit, nextCursor } }`, and errors
> `{ error: { code, message, requestId, details? } }`. Domain rules are in
> [BOOKINGS.md](../platform/BOOKINGS.md).

There are three audiences and they never share endpoints:

- **public / patients** (`Authorization: Bearer`);
- **guests** (`X-Guest-Token`);
- **clinic staff** (`Authorization` + `X-Clinic-Id`).

No worker or maintenance endpoint exists.

## Availability

| Method & path                                                                      | Auth    | Notes                                                             |
| ---------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| GET `/availability?clinicId&branchId&serviceId&from&to[&assignmentId][&mode=SLOT]` | none    | ≤ 14 days; `mode=QUEUE` → `422 BOOKING_MODE_NOT_SUPPORTED`        |
| GET `/me/availability?…[&personId]`                                                | patient | also removes the patient's (or delegated person's) own busy times |

```jsonc
// GET /availability?clinicId=7&branchId=12&serviceId=40&from=2026-11-15&to=2026-11-15
{
  "data": {
    "clinicId": "7",
    "branchId": "12",
    "serviceId": "40",
    "mode": "SLOT",
    "timeZone": "Africa/Cairo",
    "available": true,
    "reason": null,
    "slots": [
      {
        "assignmentId": "31",
        "doctor": { "displayName": "Dr. Synthetic Example" },
        "startsAt": "2026-11-15T07:00:00.000Z",
        "endsAt": "2026-11-15T07:30:00.000Z",
        "local": { "date": "2026-11-15", "start": "09:00", "end": "09:30" },
        "durationMinutes": 30,
        "price": { "amountMinor": 20000, "currency": "EGP" },
      },
    ],
  },
}
// Not bookable: { "available": false, "reason": "NOT_ACCEPTING_BOOKINGS" | "SLOT_BOOKING_DISABLED" | "NO_SLOTS", "slots": [] }
```

## Patients (`Authorization`; PATIENT role granted on first use)

| Method & path                                                                                                                        | Permission                    | Notes                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/me/booking-persons`                                                                                                            | own                           | self plus delegated persons                                                                                                                                                                                                                                 |
| POST `/me/dependents` `{displayName, birthDate?, relationship, authorityStatement?}`                                                 | own                           | DECLARED delegation                                                                                                                                                                                                                                         |
| GET / POST `/me/delegates` `{phone, relationship}`                                                                                   | own                           | CONSENT: who may book for me                                                                                                                                                                                                                                |
| POST `/me/delegations/:delegationId/revoke`                                                                                          | delegate or person            | 204                                                                                                                                                                                                                                                         |
| POST `/me/guest-bookings/claim` `{claimCode}`                                                                                        | own                           | claims a guest person with its one-time claim code (never by phone) and links it to the account's canonical booking identity; returns `identityConflicts` (overlaps recorded, nothing cancelled); idempotent; `400 CLAIM_INVALID`, `429 CLAIM_RATE_LIMITED` |
| GET / POST `/me/identity-cases` `{kind?: GUEST_OWNERSHIP \| IDENTITY_LINK, statement, bookingReference?}`                            | own                           | support-assisted ownership or identity-link verification (202); `IDENTITY_LINK` requires `bookingReference`                                                                                                                                                 |
| POST `/me/phone/change-requests` `{phone}`, then POST `…/verify` `{phone, currentChallengeId, currentCode, newChallengeId, newCode}` | own                           | verified phone change (codes to both phones); `409 PHONE_UNAVAILABLE`                                                                                                                                                                                       |
| POST `/me/bookings` + **`Idempotency-Key`** `{clinicId, branchId, serviceId, assignmentId, startsAt, personId?, note?}`              | `patient.bookings.manage_own` | 201 PENDING_CONFIRMATION                                                                                                                                                                                                                                    |
| GET `/me/bookings?status&limit&cursor`                                                                                               | `patient.bookings.view_own`   | own and delegated persons                                                                                                                                                                                                                                   |
| GET `/me/bookings/:bookingId`                                                                                                        | view_own + ownership          | includes `history`                                                                                                                                                                                                                                          |
| POST `/me/bookings/:bookingId/cancel` `{reason?}`                                                                                    | manage_own + ownership        | snapshotted policy                                                                                                                                                                                                                                          |
| POST `/me/bookings/:bookingId/reschedule` + **`Idempotency-Key`** `{startsAt, assignmentId?}`                                        | manage_own + ownership        | 201 replacement                                                                                                                                                                                                                                             |

```jsonc
// POST /me/bookings   Idempotency-Key: 6f1c0f0e-book-0001
{ "clinicId": "7", "branchId": "12", "serviceId": "40", "assignmentId": "31", "startsAt": "2026-11-15T07:00:00.000Z" }
// → 201
{ "data": { "id": "501", "mode": "SLOT", "status": "PENDING_CONFIRMATION",
  "clinic": { "id": "7", "name": "Synthetic Health Clinic" }, "branch": { "id": "12", "name": "Main", "timeZone": "Africa/Cairo" },
  "doctor": { "displayName": "Dr. Synthetic Example" }, "service": { "id": "40", "name": { "en": "Consultation", "ar": "كشف" } },
  "assignmentId": "31", "startsAt": "2026-11-15T07:00:00.000Z", "endsAt": "2026-11-15T07:30:00.000Z",
  "local": { "date": "2026-11-15", "start": "09:00", "end": "09:30" }, "durationMinutes": 30,
  "price": { "amountMinor": 20000, "currency": "EGP" }, "confirmationDeadline": "2026-11-13T12:00:00.000Z",
  "cancellationPolicy": { "minNoticeMinutes": 1440, "reasonRequired": false, "patientCancelUntil": "2026-11-14T07:00:00.000Z" },
  "rescheduleOfBookingId": null, "supersededByBookingId": null, "statusReason": null,
  "patient": { "personId": "88", "displayName": "Synthetic Patient" }, "bookedBy": { "kind": "SELF", "relationship": null } } }
```

## Guests (`X-Guest-Token` after phone verification)

| Method & path                                                                           | Notes                                                                                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| POST `/guest/verifications` `{phone}`                                                   | 202 `{challengeId, expiresAt, resendAvailableAt}` (OTP limits apply)                                      |
| POST `/guest/verifications/verify` `{challengeId, phone, code}`                         | `{guestToken, expiresAt}` (60 min); `400 OTP_INVALID` / `OTP_ATTEMPTS_EXCEEDED`                           |
| POST `/guest/bookings` + **`Idempotency-Key`** `{…slot fields, patient: {displayName}}` | 201                                                                                                       |
| GET `/guest/bookings`, GET `/guest/bookings/:bookingId`                                 | that phone's bookings only                                                                                |
| POST `/guest/bookings/:bookingId/cancel` `{reason?}`                                    | snapshotted policy                                                                                        |
| POST `/guest/sessions/attach` `{claimCode}`                                             | re-attach a returning guest's person (code + same verified phone); 5 failures → `429 GUEST_ATTACH_LOCKED` |
| POST `/guest/claim-codes`                                                               | rotate: revoke active codes, return a new one once (`no-store`)                                           |

The first `201` of a new guest person also returns `guestAccess: { claimCode, expiresAt }` once (`Cache-Control: no-store`). It is never repeated, not even on an idempotent replay.

## Clinic (`Authorization` + `X-Clinic-Id`)

| Method & path                                                                                                                                                                          | Permission (branch of the booking)                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| GET `/clinic/bookings?branchId&assignmentId&serviceId&patientProfileId&status&from&to&limit&cursor`                                                                                    | `clinic.bookings.view` (covered branches only)                  |
| POST `/clinic/bookings` + **`Idempotency-Key`** `{branchId, serviceId, assignmentId, startsAt, note?, patient: {patientProfileId} \| {new: {displayName, birthDate?, contactPhone?}}}` | `clinic.bookings.manage` (staff-created; the result is PENDING) |
| GET `/clinic/bookings/:bookingId`                                                                                                                                                      | `clinic.bookings.view`                                          |
| POST `/clinic/bookings/:bookingId/confirm` (optional `Idempotency-Key`)                                                                                                                | `clinic.bookings.manage`                                        |
| POST `/clinic/bookings/:bookingId/reject` `{reason}`                                                                                                                                   | `clinic.bookings.cancel`                                        |
| POST `/clinic/bookings/:bookingId/cancel` `{reason}`                                                                                                                                   | `clinic.bookings.cancel`                                        |
| GET / PUT `/clinic/booking-settings`                                                                                                                                                   | any member / `clinic.settings.manage`                           |

The clinic view adds `patient: { patientProfileId, displayName, contactPhone }` and
`patientNote`. Confirming a replacement supersedes its original (`RESCHEDULED`).

## Error codes

| Code                                                        | Status    | When                                                                                    |
| ----------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `IDEMPOTENCY_KEY_REQUIRED` / `_INVALID`                     | 400       | missing or malformed header                                                             |
| `IDEMPOTENCY_KEY_REUSED`                                    | 409       | same key, different payload                                                             |
| `IDEMPOTENCY_KEY_EXPIRED`                                   | 409       | key older than the 7-day replay window (tombstone)                                      |
| `CLAIM_INVALID`                                             | 400       | wrong, used, revoked, expired or foreign claim code                                     |
| `SLOT_UNAVAILABLE`                                          | 409       | not a current slot: taken (in any clinic), outside working time, stale, wrong grid      |
| `PATIENT_CONFLICT`                                          | 409       | the patient has an overlapping appointment                                              |
| `CLINIC_NOT_ACCEPTING_BOOKINGS`                             | 409       | the gate refuses new operations (generic for patients)                                  |
| `SLOT_BOOKING_DISABLED`                                     | 409       | the clinic disabled slot booking                                                        |
| `BOOKING_EXPIRED`                                           | 409       | confirming after the deadline                                                           |
| `BOOKING_NOT_CONFIRMABLE`                                   | 409       | doctor or service no longer available                                                   |
| `RESCHEDULE_PENDING`                                        | 409       | a replacement is already pending                                                        |
| `CANCELLATION_NOT_ALLOWED` / `CANCELLATION_REASON_REQUIRED` | 409 / 400 | policy snapshot                                                                         |
| `INVALID_TRANSITION`                                        | 409       | status machine                                                                          |
| `GUEST_SESSION_INVALID`                                     | 401       | missing, expired or unknown guest token                                                 |
| `PERSON_LINK_CONFLICT`                                      | 409       | the verified phone is linked to another account                                         |
| `IDENTITY_LINK_SUPERSEDED`                                  | 409       | revoking a link that a newer link superseded; revoke the current link instead           |
| `IDENTITY_OWNED_ELSEWHERE` / `IDENTITY_LINK_NOT_ALLOWED`    | 409       | linking a person owned by another account / an account (SELF) person                    |
| `IDENTITY_CONFLICT_STILL_OVERLAPPING`                       | 409       | resolving a link conflict while both bookings still hold time in one identity           |
| `IDENTITY_CONFLICT_ALREADY_RESOLVED`                        | 409       | a different request for an already resolved conflict (final)                            |
| `SELF_APPROVAL_FORBIDDEN`                                   | 403       | a Super Admin acting on an identity case, link or conflict involving their own identity |
| `CONFLICT`                                                  | 409       | the identity changed concurrently (retry), or the link is already revoked               |
| `BOOKING_MODE_NOT_SUPPORTED`, `QUEUE_MODE_NOT_AVAILABLE`    | 422       | queue mode (Task 06)                                                                    |

Foreign or unrelated ids (another clinic, another patient, an uncovered branch) are always
`404`.

## Super Admin (MFA)

| Method & path                                                                                                                 | Permission                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/admin/identity-cases?status`                                                                                            | `platform.identity.resolve`                                                                                                                                                                                                 |
| POST `/admin/identity-cases/:caseId/resolve` `{decision: LINK \| REJECT, personId?, evidenceType?, reason, verificationNote}` | `platform.identity.resolve`; never the requester (`403 SELF_APPROVAL_FORBIDDEN`); LINK requires `personId` and `evidenceType` (`ID_DOCUMENT`, `BOOKING_DETAILS`, `CLINIC_ATTESTATION`, `OTHER`)                             |
| GET `/admin/booking-persons/:personId/identity-links`                                                                         | `platform.identity.resolve`; link history of a person                                                                                                                                                                       |
| POST `/admin/identity-links/:linkId/revoke` `{reason, releaseOwnership?}`                                                     | `platform.identity.resolve`; never an involved admin; ACTIVE links only; back to the origin identity; history kept; returns `{linkId, status, ownershipReleased}`                                                           |
| GET `/admin/identity-link-conflicts?status=OPEN\|ALL`                                                                         | `platform.identity.resolve`; status `OPEN` (live overlap) / `CLEARED` / `RESOLVED`, with the recorded resolution                                                                                                            |
| POST `/admin/identity-link-conflicts/:conflictId/resolve` `{note}`                                                            | `platform.identity.resolve`; never an involved admin; only once the overlap is gone; returns `200 {conflictId, status, method, resolvedAt, resolvedByUserId, alreadyResolved}` (was `204` in 05.2); never changes a booking |
