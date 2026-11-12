# Task 05.1 report: Booking identity security, guest claim protection and staff-created bookings

| Field  | Value                                     |
| ------ | ----------------------------------------- |
| Task   | 05.1, hardening and completion of Task 05 |
| Date   | 2026-11-12                                |
| Status | Awaiting project-owner review             |
| Next   | Owner review. **Task 06 not started.**    |

## 1. Inspection findings (behaviour before this task)

1. **Phone-only claiming (vulnerability).** `selfPerson` linked any account-less SELF person
   whose phone hash matched the account's phone. Whoever controlled a number therefore
   inherited its guest bookings, including after the number was recycled.
2. **Phone-keyed guest sessions.** `guestPerson` and `GET /guest/bookings` resolved the person by
   phone hash alone. A new owner of a recycled number could therefore see a previous owner's
   bookings, even account-linked ones.
3. `/me/guest-bookings/claim` required no proof beyond the account's phone.
4. No account phone-change flow existed (phones were immutable).
5. **Outbox:** booking changes, history, audit and events were already in one transaction
   (confirmed by code reading, and now by fault injection).
6. **Idempotency:** keys never expired, and there was no retention policy.

## 2. Guest ownership and claim security (ADR-050, amends ADR-045)

**Identity model:**

- the phone hash is **not unique and not an identity key** (migration 180002);
- SELF persons are keyed by `user_id`;
- new kinds `GUEST` (guest-created) and `CLINIC` (staff-recorded);
- persons are never merged and never matched by phone.

**Guest sessions** (60 minutes, unchanged) now bind to exactly one person: the one they create,
or one they attach with **claim code + same verified phone**. Five failed attaches lock the
session.

**Claim code:**

- 256-bit base64url, `randomToken(32)`;
- SHA-256 stored in `guest_claim_codes`, UNIQUE hash;
- 365 days, ACTIVE → USED (account claim) or REVOKED (rotation);
- returned **once** in `guestAccess.claimCode` of the guest's first `201`
  (`Cache-Control: no-store`);
- added **after** the idempotent transaction, so it is never in stored replays;
- log redaction covers `claimCode`, `guestToken` and `x-guest-token`;
- a test asserts the code is absent from idempotency rows, audit and outbox.

**Claim** (`POST /me/guest-bookings/claim { claimCode }`):

- the code and person rows are locked, the account becomes owner (`claimed_by_user_id`), the
  code becomes USED, the person's guest sessions are revoked, and the claim is audited;
- idempotent for the same account;
- `400 CLAIM_INVALID` for wrong, used, revoked, expired or foreign codes;
- 10 attempts per account per hour;
- clinic profiles are untouched.

**Retention by the patient:** the app stores the code, or the patient writes it down. A lost
code can be rotated from an attached session, or recovered through support.

**Legacy bookings without a code:** migration 180002 converted account-less SELF persons to
GUEST. They have no code, so they go through the support path (tested).

## 3. Phone changes, recycled numbers and support (ADR-051)

**Phone change:**

- `POST /me/phone/change-requests` sends `PHONE_CHANGE` OTPs (purpose-bound, new CHECK value)
  to the current **and** the new phone;
- `…/verify` needs both codes, and the new number must be free (`PHONE_UNAVAILABLE`);
- the identity stays the account: the person id is unchanged and bookings stay with it;
- audited (`ACCOUNT_PHONE_CHANGED`, masked numbers).

**Recycled numbers:**

- whoever verifies the old number later gets a new account or guest person and inherits
  nothing;
- the old guest bookings are reachable only with the old claim code, or through support.

**Support cases:**

- `POST /me/identity-cases` (≤ 3 open; the requester learns nothing about candidates);
- `GET /admin/identity-cases` and `POST …/:id/resolve` with `platform.identity.resolve` (new,
  SUPER_ADMIN, MFA, never the requester);
- **LINK** has the same effect as a claim and revokes the person's codes; **REJECT** closes the
  case;
- audited (`IDENTITY_CASE_OPENED`, `IDENTITY_CASE_RESOLVED`, `BOOKING_PERSON_CLAIMED`).

The manual verification runbook (call back the platform-held number, booking details only the
booker knows, out-of-band ID where required, reject when in doubt) is in
[BOOKING_PERSONS.md](../platform/BOOKING_PERSONS.md#support-assisted-ownership-verification).
Merging persons and moving bookings between them remain a future support tool (OD-27, OD-30).

## 4. Staff-created bookings (ADR-052; resolves OD-25)

`POST /clinic/bookings` (`X-Clinic-Id`, `Idempotency-Key` required) needs `clinic.bookings.manage`
for the booking's branch: receptionists, owners and managers, not doctors. Branch-assigned
staff are limited to covered branches.

- **Same engine:** the same `BookingService.create()` path, with the same lock order,
  in-transaction slot recomputation, global doctor and patient conflicts, gate, deadline,
  snapshots and idempotency. The result is a **PENDING_CONFIRMATION** request; there is no
  pre-confirmation.
- **Beneficiary:**
  - an existing patient profile **of this clinic** (another clinic's is 404);
  - or a new **CLINIC** person created **inside** the booking transaction, so it rolls back with
    a failed booking (tested). It is never phone-matched; the phone is stored only as the
    booking contact.
- **Attribution:** `actor_kind = STAFF` and `actor_user_id` = staff, separate from `person_id`.
  No delegation and no medical access are created, and there is no `personId` input (staff
  can't use patient delegations).

## 5. Outbox and idempotency (ADR-053, ADR-054)

- **Outbox atomicity** was verified by fault injection: a CHECK forces the outbox INSERT to fail
  after the booking and history inserts, and nothing remains (booking, history, event, audit,
  key). Three concurrent sweeps produce one expiry event.
- **Publisher and consumer responsibilities** are documented in BOOKINGS.md § Events:
  - at-least-once delivery, marked published only after acceptance, never deleting unpublished
    events;
  - consumers de-duplicate by event id, re-read state, and never put medical details in
    notifications.
- **Idempotency retention:**
  - responses replay for 7 days;
  - the daily `idempotency-retention` job then nulls the body and sets `expired_at`, keeping a
    **tombstone**;
  - a late retry gets `409 IDEMPOTENCY_KEY_EXPIRED` and never re-executes (tested with the
    slot free again);
  - rows are never deleted.
- **Phone-hash key rotation:** `phone_hash_key_version` was added to persons and guest sessions.
  The versioned procedure is documented. Because hashes no longer decide ownership, rotation
  cannot orphan identities.

## 6. Database

There are seven new forward-only migrations; no applied migration was edited.

| Migration        | Change                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `20261111180001` | OTP purpose CHECK + `PHONE_CHANGE`                                                                                      |
| `20261111180002` | booking persons: non-unique phone hash, key version, `claimed_by_user_id`/`claimed_at`, new kind CHECK, data conversion |
| `20261111180003` | `guest_claim_codes`                                                                                                     |
| `20261111180004` | guest sessions: `person_id`, `failed_attach_count`, key version                                                         |
| `20261111180005` | `identity_support_cases`                                                                                                |
| `20261111180006` | `idempotency_keys.expired_at`                                                                                           |
| `20261111180007` | permission `platform.identity.resolve`                                                                                  |

Details are in [BOOKINGS_SCHEMA.md](../database/BOOKINGS_SCHEMA.md).

## 7. Tests (actually executed)

| Suite                                                                         | Result                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------- |
| `bookings/identity.test.ts` (new)                                             | ✅ 8 passed                                     |
| `bookings/staff.test.ts` (new)                                                | ✅ 7 passed                                     |
| `bookings/outbox-idempotency.test.ts` (new)                                   | ✅ 4 passed                                     |
| `bookings/creation.test.ts` (guest-claim test updated to the claim-code rule) | ✅ 7 passed                                     |
| `npm run test:bookings`                                                       | ✅ 7 files, **59 passed**                       |
| `npm test` (unit)                                                             | ✅ 24 files, **237 passed**                     |
| `npm run test:integration` (Tasks 01–05.1)                                    | ✅ 31 files, **290 passed** (Task 05: 28 / 271) |

**Concurrency** (competing requests → successes):

| Race                                                                                                                                                              | Competitors | Successes    | Others                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------ | ---------------------------------------- |
| Accounts claiming one guest code                                                                                                                                  | 4           | **1**        | 3 × `CLAIM_INVALID`; one owner in the DB |
| Two receptionists + two patients for one slot                                                                                                                     | 4           | **1**        | 3 × `SLOT_UNAVAILABLE`                   |
| Concurrent expiry sweeps                                                                                                                                          | 3           | **1** expiry | 1 event, 1 history row                   |
| Task 05 races (still passing): six patients for one slot, doctor in two clinics, patient in two clinics, three replacements, three identical idempotent creations | —           | 1 each       | —                                        |

**Mutation checks (performed, then restored):**

- re-introducing phone-based guest person selection failed the recycled-number test;
- allowing reuse of a claimed or used code failed 2 tests (claim reuse and the claim race).

## 8. Format, lint, typecheck, build and migrations

- `npm run format:check` ✅ · `npm run lint` ✅ (7 findings in new code fixed, none suppressed)
  · `npm run typecheck` ✅ · `npm run build` ✅
- `npm run migrate`: 7 applied. `migrate:status`: **69 applied, 0 pending**. A re-run applies
  `count: 0`.
- Dev vs test schema and catalog dump: **identical** (1,379 lines).
- A fresh scratch database built from all 69 files has 59 tables and 82 role grants, equal to
  dev. The scratch database was dropped afterwards.

## 9. Remaining limitations

- **Claim-code delivery** is only the one-time API response (no SMS or email provider). A lost
  code needs rotation from an attached session, or support.
- **Two persons for one human** (claimed guest + own SELF): kept separate, and patient
  conflicts don't cross between them (OD-30). Staff-recorded CLINIC persons likewise stay
  separate from any account.
- **The support tool is minimal:** LINK or REJECT only, with no merge, booking transfer or
  appeal (OD-27).
- **Phone change** keeps existing sessions, and doesn't notify the old number beyond the OTP
  itself.
- **Key rotation:** only version 1 exists. Comparing against multiple key versions is
  documented, not implemented.
- **No outbox publisher or consumers** (OD-29).
- **Old auto-links:** SELF persons auto-linked to accounts under the old Task 05 rule keep that
  link. Only local dev/test data existed. A real environment would need an audit query before
  deployment, documented here as a precondition.

## 10. Decisions and deviations

- Ownership by claim code (ADR-050), phone change needing both phones (ADR-051), staff bookings
  through the same engine with clinic-recorded persons (ADR-052), tombstone retention (ADR-053)
  and versioned hash keys (ADR-054).
- New permission `platform.identity.resolve`.
- The Task 05 test of phone-based claiming was changed to the new, stricter rule. It is
  intended behaviour, not a weakened test.

## 11. Exact commands

```bash
npm run migrate && npm run migrate:status && npm run migrate        # 7 applied → 69/0 → count 0
npx vitest run --config vitest.integration.config.ts tests/integration/bookings/identity.test.ts      # in apps/backend
npx vitest run --config vitest.integration.config.ts tests/integration/bookings/staff.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/bookings/outbox-idempotency.test.ts
npm run test:bookings
npm test
npm run test:integration
npm run format:check && npm run lint && npm run typecheck && npm run build
# schema parity: information_schema dump medibook vs medibook_test → diff (identical)
# fresh build: all 69 files into a scratch schema → 59 tables, 82 grants → dropped
```
