# Booking persons, ownership, delegation and guests

> **Purpose:** who an appointment is for, who may book it or own it, how guests book without
> an account and later prove ownership, and what happens on phone changes and recycled numbers.
> All of this is separate from medical records and consent. Decisions: ADR-045 (amended),
> ADR-050, ADR-051, ADR-054, ADR-055, ADR-056, ADR-057. Related: [BOOKINGS.md](BOOKINGS.md) ·
> [AUTHENTICATION.md](../security/AUTHENTICATION.md).

## Principle: a phone number is not an identity

Phone numbers change hands, so controlling a number today proves nothing about bookings made
with it in the past. Ownership comes **only** from one of these:

- the account itself (its own person);
- a **claim code** issued to the guest who created the bookings;
- a delegation;
- an audited **support decision**.

Booking persons are **never merged and never matched by phone**. The phone hash on a person is
informational: it is a re-attach factor for guests and a support signal. Person records that
belong to the same human are instead **linked** to one canonical booking identity, by the same
proofs (see below).

## Identities

| Identity               | Table                | Scope               | Notes                                                                                                                   |
| ---------------------- | -------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Booking identity       | `booking_identities` | global, non-medical | **the patient conflict key**; groups the person records of one verified human (ADR-055)                                 |
| Booking person         | `booking_persons`    | global, non-medical | who an appointment is for, and booking ownership; `identity_id` (current) and `origin_identity_id` (its own, immutable) |
| Clinic patient profile | `patient_profiles`   | one clinic          | the clinic's record; linked by `person_id` (one per person per clinic); never merged or re-linked by claims             |

| Person kind | Created by                                          | Owner                                                                              | Phone hash                                                           |
| ----------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `SELF`      | an account's first booking use                      | the account (`user_id`)                                                            | the account's current phone, refreshed after a verified phone change |
| `GUEST`     | a verified-phone guest session                      | the guest (claim code); after a claim, the claiming account (`claimed_by_user_id`) | the guest's verified phone at creation                               |
| `DEPENDENT` | `POST /me/dependents`                               | delegates (DECLARED)                                                               | none                                                                 |
| `CLINIC`    | clinic staff (`POST /clinic/bookings`, new patient) | the clinic record (no login)                                                       | none (the contact phone is stored on the booking only)               |

## Guests

1. `POST /guest/verifications` sends an OTP with purpose `GUEST_BOOKING`.
   `POST /guest/verifications/verify` returns a **60-minute guest token** (hash stored,
   `Cache-Control: no-store`). No account is created.
2. A guest session acts for **exactly one** guest person:
   - the person it creates on its first booking, or
   - one it attaches with that person's claim code.

   A verified phone **never** selects an existing person: a new session for the same number
   starts empty.

3. The first booking of a new guest person returns a **claim code** once, in
   `guestAccess.claimCode` of the `201` response (`Cache-Control: no-store`). The code is:
   - 256-bit, base64url;
   - stored only as SHA-256 (`guest_claim_codes`);
   - never part of stored idempotent replays, audit, outbox, logs or URLs (log redaction covers
     `claimCode` and `guestToken`);
   - valid for 365 days.

   The patient keeps it (the app stores it, or the patient writes it down). It is the only
   proof of ownership.

4. **Returning guest.** Verify the phone again, then `POST /guest/sessions/attach { claimCode }`.
   This needs the code **and** the same verified phone (two factors). Five failures lock the
   session (`429 GUEST_ATTACH_LOCKED`).
5. **Lost or exposed code.** `POST /guest/claim-codes` (from an attached session) revokes the
   active codes and returns a new one once.

## Claiming guest bookings into an account

`POST /me/guest-bookings/claim { claimCode }` (authenticated):

- **Atomic:** the code row and the person row are locked, then the account becomes
  `claimed_by_user_id`, the code becomes `USED`, the person's guest sessions are revoked, and an
  audit event `BOOKING_PERSON_CLAIMED { via: CLAIM_CODE }` is written, all in one transaction.
- **Idempotent** for the same account (`alreadyClaimed: true`). A used, revoked, expired,
  foreign or unknown code is the same `400 CLAIM_INVALID` (no oracle). Claims are rate-limited
  to 10 per account per hour.
- **Exactly one winner** when several accounts race (tested: 4 racing accounts, 1 success).
- **No merge.** The guest person stays a separate person owned by the account. Its bookings
  show in `/me/bookings`, and it can be booked for (`/me/booking-persons`, `claimed: true`).
  The claim also **links** the guest person to the account's canonical identity (link source
  `CLAIM_CODE`), so the account and the claimed guest person can no longer hold overlapping
  appointments (Task 05.2). Overlaps that already existed are recorded, not cancelled (see
  [Link conflicts](#link-conflicts)). The response reports them in `identityConflicts`.
- Clinic patient profiles are **not** re-linked by a claim.

## Phone changes and recycled numbers

- **Verified phone change** (`POST /me/phone/change-requests`, then `…/verify`) needs
  `PHONE_CHANGE` OTPs to **both** the current and the new phone. The number must not belong to
  another account (`409 PHONE_UNAVAILABLE`). Identity is the account, so the SELF person,
  claimed persons, delegations and clinic profiles stay as they are. The person's informational
  phone hash follows on next use. Audited as `ACCOUNT_PHONE_CHANGED` with masked numbers.
- **The old number** is free. Whoever verifies it later gets a **new** account or guest person
  and inherits nothing (tested).
- **Recycled numbers in guest bookings.** The new owner's guest session creates a new guest
  person. The previous owner's bookings stay reachable only with the previous owner's claim
  code, or through support.
- **Lost the current phone** (cannot receive the current-phone code): use a support case.

## Support-assisted ownership verification

There are two case kinds:

| `kind`                      | For                                                                                 | Candidates recorded for support                               | LINK effect                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `GUEST_OWNERSHIP` (default) | guest bookings without a claim code (made before Task 05.1, or a lost code)         | unclaimed GUEST persons with the account's current phone hash | ownership (as a claim) **and** identity link                       |
| `IDENTITY_LINK`             | a clinic-recorded (CLINIC) or guest person of a given booking that is the requester | the CLINIC/GUEST person(s) of `bookingReference` (required)   | identity link **only**: no ownership, visibility or medical access |

1. The account opens a case with
   `POST /me/identity-cases { kind?, statement, bookingReference? }` (≤ 3 open cases). The
   response says only "OPEN". Candidates are a signal for support, never a decision; the
   requester learns nothing about them.
2. A Super Admin with **`platform.identity.resolve`** and MFA reviews it via
   `GET /admin/identity-cases?status=OPEN`. The requester can never resolve their own case
   (`SELF_APPROVAL_FORBIDDEN`).
3. **Manual verification procedure** (support runbook):
   1. Call back the account's verified phone, from the platform's own records, not a number the
      requester supplies.
   2. Ask the requester for details only the booker knows: the clinic, branch, doctor, date and
      time, the name given at booking, and the booking reference. Compare them with the
      candidate person's bookings.
   3. Where legally required or the bookings are sensitive, verify a government ID out of band.
      Record the method, never the document, in `verificationNote`.
   4. If the evidence is inconclusive, choose **REJECT**. Never link "to be helpful".
4. `POST /admin/identity-cases/:id/resolve { decision: LINK | REJECT, personId?, evidenceType?, reason, verificationNote }`:
   - **LINK** requires `personId` (a candidate) and `evidenceType`: `ID_DOCUMENT`,
     `BOOKING_DETAILS`, `CLINIC_ATTESTATION` or `OTHER` (`CLAIM_CODE` is reserved for claims).
     For `GUEST_OWNERSHIP` it makes the requester the owner of the guest person, with the same
     effect as a claim (codes revoked, guest sessions end), and links it. For `IDENTITY_LINK` it
     only links the person to the requester's identity. The case records `evidence_type` and
     `link_id`.
   - **REJECT** closes the case and changes nothing else (tested).

   Both are audited (`IDENTITY_CASE_OPENED`, `IDENTITY_CASE_RESOLVED`, on LINK
   `IDENTITY_LINKED` and, for ownership, `BOOKING_PERSON_CLAIMED { via: SUPPORT_CASE }`). A
   wrong LINK is corrected by revoking the link (below), never by editing the case.

5. **Not covered here** (future workflow): moving bookings between persons, re-linking clinic
   profiles, dual approval and appeals (OD-27). Person records are linked, never merged.

## Canonical booking identity

> Decisions: ADR-055 (identity), ADR-056 (link conflicts and correction), ADR-057 (link
> lifecycle: supersede, self-approval, conflict resolution).

**Problem.** One human can have several person records: their account's SELF person, guest
persons (claimed or not), and CLINIC persons recorded by staff. Before Task 05.2 each record was
its own conflict key, so one human could hold overlapping appointments in different clinics.

**Model.**

- Every person row has `identity_id` (current canonical identity) and `origin_identity_id` (the
  identity it was created with; immutable, UNIQUE). New persons get a new identity.
- The **patient conflict check** uses the identity: all holding bookings of all persons in it,
  in every clinic, for availability, creation, confirmation and rescheduling.
- A **link** moves exactly **one** person (GUEST or CLINIC) into an **account's** identity
  (the identity anchored by that account's SELF person), and writes an append-only
  `booking_identity_links` row: from and to identity, `source`
  (`CLAIM_CODE` | `SUPPORT_CASE` | `MIGRATION_CLAIM`), `evidence_type`, case, actor and reason
  (ADR-057).
- **Guards** (`409`):
  - SELF persons never move (`IDENTITY_LINK_NOT_ALLOWED`);
  - a person owned by one account is never linked into another account's identity
    (`IDENTITY_OWNED_ELSEWHERE`); correct the ownership first.
- **Supersede.** A newer verified link for a person who is already linked moves only that
  person. The previous link becomes `SUPERSEDED` (`superseded_by_link_id`); the previous
  account's own records stay where they are. At most one link per person is `ACTIVE`.
- **Nothing else changes:** bookings keep their `person_id`, patient profile, actor and
  beneficiary; status history and audit are untouched; clinic patient profiles and medical
  records are never merged or re-linked.

**Link vs ownership vs access.**

| Concept             | Stored as                     | Grants                                              |
| ------------------- | ----------------------------- | --------------------------------------------------- |
| Identity link       | `booking_persons.identity_id` | nothing except shared conflict checking             |
| Ownership (claim)   | `claimed_by_user_id`          | seeing and booking for that person from the account |
| Medical-record link | (future, clinic side)         | out of scope; never derived from booking identity   |

**Sources of a link** (phone equality is never one):

1. a successful claim (`CLAIM_CODE`);
2. a resolved support case (`SUPPORT_CASE`, evidence type required);
3. the Task 05.2 backfill of claim-code claims made in Task 05.1 (`MIGRATION_CLAIM`).

### Staff-created patients: known limitation

- A patient recorded by clinic staff (a CLINIC person) has **no independently verified
  identity**, so it **remains a separate identity**.
- **Global patient-conflict detection is guaranteed only between records linked to the same
  canonical booking identity.** Until a walk-in is linked, the same human can hold an
  overlapping appointment in another clinic, under their account or another record.
- **A matching phone number is never sufficient evidence** for linking. Staff-entered phones
  are stored only as the booking contact and are never compared with accounts.
- The supported path today is a **support-assisted** `IDENTITY_LINK` case that names the clinic
  booking and is resolved with evidence (typically `CLINIC_ATTESTATION` or `BOOKING_DETAILS`). A
  future verified patient-claim flow (for example a clinic-issued claim code) could associate
  the records the same way.
- **Linking never grants medical-record access and never merges clinic-scoped patient
  profiles.** It gives the account no visibility of the clinic's booking (tested). There is no
  general patient-record merge feature, and none is planned in the booking engine.

### Link conflicts

When a link joins identities that already hold overlapping bookings (both were valid when made):

- the link still succeeds;
- each overlapping pair is stored in `identity_link_conflicts` and audited
  (`IDENTITY_LINK_CONFLICT`);
- **neither booking is cancelled or rescheduled**;
- confirming either booking fails with `409 PATIENT_CONFLICT` while the other holds time;
- the patient or clinic cancels one booking through the normal flows, or support revokes a
  wrong link. Support never changes a booking from the conflict tools.

**Conflict status** (`GET /admin/identity-link-conflicts?status=OPEN|ALL`):

| Status     | Meaning                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `OPEN`     | both bookings hold time **and** their persons still share one identity                       |
| `CLEARED`  | the overlap is gone (a booking released its time, or the link was revoked); not recorded yet |
| `RESOLVED` | support recorded the resolution (final)                                                      |

**Resolving** (`POST /admin/identity-link-conflicts/:id/resolve { note }`, ADR-057):

- refused with `409 IDENTITY_CONFLICT_STILL_OVERLAPPING` while the conflict is OPEN: the
  endpoint only **records** an outcome, and never cancels, reschedules, confirms or transfers a
  booking;
- records the actor, the note, the time and the **method**: `BOOKING_RELEASED` (one booking no
  longer holds time) or `LINK_REVOKED` (the persons are no longer in one identity); audited as
  `IDENTITY_LINK_CONFLICT_RESOLVED`;
- **final:**
  - the identical request (same actor, same note) replays the stored result
    (`alreadyResolved: true`) with no new effects;
  - any other request gets `409 IDENTITY_CONFLICT_ALREADY_RESOLVED`;
  - there is no reopen workflow;
- refused for an involved Super Admin (`403 SELF_APPROVAL_FORBIDDEN`, see below).

### Correcting an erroneous link

`POST /admin/identity-links/:linkId/revoke { reason, releaseOwnership? }`
(`platform.identity.resolve`, MFA):

- the person returns to its `origin_identity_id`, so it is a separate identity again;
- the link row becomes `REVOKED`, keeping who, when and why;
- only the `ACTIVE` link can be revoked. A `SUPERSEDED` link is refused with
  `409 IDENTITY_LINK_SUPERSEDED`, and the current identity and newer link stay unchanged. To
  undo, revoke the current link; the person then returns to its **own** origin, never to an
  earlier account;
- ownership (`claimed_by_user_id`) is kept unless `releaseOwnership: true`. Release clears the
  ownership in the same transaction, so the account no longer sees the person or its bookings.
  The claim code stays `USED` (a new owner needs a support case);
- the whole correction is one transaction (tested by fault injection);
- audited as `IDENTITY_LINK_REVOKED` (from/to identity, whether ownership was released, and the
  previous owner); bookings, history and earlier audit are untouched.

### Self-approval and refusals

A Super Admin is **involved**, and gets `403 SELF_APPROVAL_FORBIDDEN`, when their own account
owns, as SELF or by claim, any person currently in or originating from an affected identity, or
when they acted on one of the conflict's bookings. This applies to:

- resolving their own identity case (Task 05.1);
- revoking a link (Task 05.2.1);
- resolving a link conflict (Task 05.2.1).

The check runs in the service, inside the transaction, under the identity locks. Another
authorized Super Admin can perform the operation.

Refused privileged identity operations (`SELF_APPROVAL_FORBIDDEN`, `IDENTITY_LINK_SUPERSEDED`,
`IDENTITY_CONFLICT_STILL_OVERLAPPING`, `IDENTITY_CONFLICT_ALREADY_RESOLVED`) change nothing. The
transaction rolls back, and the refusal is recorded afterwards as a `FAILURE` security event
`IDENTITY_OPERATION_REFUSED { operation, targetId, code }`.

`GET /admin/booking-persons/:personId/identity-links` shows a person's link history.

### Legacy identity audit

Before deploying Task 05.2 to any environment with real data, run the **read-only** audit
[`apps/backend/scripts/audit-booking-identities.sql`](../../apps/backend/scripts/audit-booking-identities.sql).
It runs in one `START TRANSACTION READ ONLY` (writes fail with MySQL error 1792), prints only
hash prefixes, and **changes nothing**. Sections:

| Section | Finds                                                               | Typical origin                   |
| ------- | ------------------------------------------------------------------- | -------------------------------- |
| A       | account SELF persons holding bookings made by a guest               | Task 05 phone auto-link          |
| B       | SELF persons created before their account                           | adopted guest person (auto-link) |
| C       | claimed persons without a claim-code or support claim audit         | unexplained ownership            |
| D       | identity groups with more than one person, and how each joined      | review of all links              |
| E       | `MIGRATION_CLAIM` links and their claim audit                       | Task 05.2 backfill               |
| F       | accounts owning more than one person record                         | claims                           |
| G       | unclaimed guests sharing a phone hash with an account (signal only) | candidates for a support case    |
| H       | phone hashes shared by persons of different owners                  | recycled numbers                 |

**Review procedure** (support, two people; nothing is changed automatically):

1. Run the script against a replica or with a read-only user, and archive the output with the
   date and environment.
2. A, B and C are **suspect associations**. For each one, contact the account holder through the
   platform's verified channel, and use the manual verification runbook above.
3. If ownership is confirmed, record a support case with evidence. If it is disproved, plan the
   correction (revoke a link; ownership transfer is OD-27 tooling) as a separate, reviewed
   change. **Never unlink or merge directly from the audit.**
4. D, E and F are checked for a matching claim or case. G and H are signals only and never
   justify a link.

Result in dev on 2026-11-12: no booking data; every section empty. The queries were validated
against synthetic anomalies seeded into the disposable test database (Task 05.2 report).

## Delegation (booking for another person)

This is unchanged from Task 05:

- **DECLARED** dependents: GUARDIAN only for minors, otherwise a recorded authority statement.
- **CONSENT** from the person's own account.
- Scope is BOOKING only (DB CHECK). Delegation never grants medical-record access or consent
  authority.
- Revocable by either side with immediate effect, and audited.

**Clinic staff do not use delegations.** They book for patients of their own clinic (see
BOOKINGS.md § Staff-created bookings).

## Phone identity hash key rotation

Phone hashes are HMAC-SHA256 with a key derived from `AUTH_SECRET` (`subject-hash`). Every
stored hash carries `phone_hash_key_version` (`booking_persons`, `guest_booking_sessions`;
currently 1). Since Task 05.1, hashes no longer decide ownership, so rotating the key can never
orphan an identity: SELF persons are keyed by `user_id`, and guest persons by claim codes.

To rotate:

1. Add the new key as version N+1 alongside version N (do not remove N).
2. Write new hashes with N+1.
3. Where code compares hashes (guest re-attach, support candidates), compare against every
   active version.
4. Re-hash lazily on the next verified contact (SELF on next use; new guest sessions), or in a
   batch job from a verified phone where one is held.
5. When no row references version N anymore (count by version), retire it.

An unhashable old guest hash only means support lists fewer candidates. It never moves a
booking.

## PATIENT role

The first patient booking use grants the global PATIENT role (audited). This resolves OD-07.
