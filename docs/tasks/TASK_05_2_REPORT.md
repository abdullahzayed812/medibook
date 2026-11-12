# Task 05.2 report: Canonical booking identity (resolves OD-30)

> **Purpose:** what Task 05.2 found, changed, tested and left open. It covers one canonical
> booking identity per verified human, which is the patient conflict key across person records.

| Field  | Value                                  |
| ------ | -------------------------------------- |
| Task   | 05.2, correction of Task 05.1 (OD-30)  |
| Date   | 2026-11-12                             |
| Status | Correction 05.2.1 issued               |
| Next   | Owner review. **Task 06 not started.** |

> **Correction 05.2.1 issued** ([TASK_05_2_1_REPORT.md](TASK_05_2_1_REPORT.md), ADR-057). It
> changes or closes the following points of this report:
>
> - §2: a link now moves **one** person, not "its whole current identity group". The group move
>   could drag another account's SELF person along; this was fixed.
> - §3: links can be `SUPERSEDED`. Conflict resolution returns `200` with the recorded
>   resolution (it was `204`), is refused while the overlap is live, and the list shows
>   `OPEN` / `CLEARED` / `RESOLVED`.
> - §9: the untested paths and the missing self-approval guard on revocation are addressed.

## 1. Inspection findings (behaviour before this task)

The patient conflict key was `bookings.person_id`. One human could own several person records,
and each was checked only against itself:

1. **Account + claimed guest person.** After a claim, the account's SELF person and the claimed
   GUEST person were separate keys. The same human could hold overlapping appointments in two
   clinics (OD-30).
2. **Account + unclaimed guest person.** These were separate until claimed, and linking them by
   phone is forbidden.
3. **Several guest sessions without attach.** Each created a new guest person.
4. **Staff-created CLINIC persons.** They are recorded without proof of identity and are never
   phone-matched.
5. **Support LINK (Task 05.1).** It transferred ownership only, so conflicts still did not cross.

The database second line (UNIQUE `(person_id, starts_at, active_key)`) is per person record, so
it couldn't close this either.

## 2. Model (ADR-055)

- **`booking_identities`** is the conflict key. Each `booking_persons` row has a mutable
  `identity_id` and an immutable, UNIQUE `origin_identity_id`. Every new person (SELF, GUEST,
  DEPENDENT, CLINIC) gets its own identity in the same transaction.
- **Conflicts by identity.** `identityBusy` (it replaces `personBusy`) checks all holding
  bookings of all persons in the identity, in every clinic. It is used for availability
  (`/me/availability` maps `personId` to its identity), creation, confirmation and rescheduling.
- **Link, never merge.** A link moves a person and its whole current identity group into another
  identity, and writes one append-only `booking_identity_links` row per moved person (source,
  evidence, case, actor, reason).
- **Nothing historical changes:** bookings keep `person_id`, patient profile, actor and
  beneficiary; status history and audit are untouched; clinic patient profiles and medical
  records are never merged or re-linked (tested by before/after row equality).
- **Link sources** (never phone equality):
  - a successful claim (`CLAIM_CODE`);
  - a resolved support case with a mandatory evidence type (`SUPPORT_CASE`);
  - the backfill of earlier claim-code claims (`MIGRATION_CLAIM`).
- **Link ≠ ownership ≠ access.** An identity link only shares conflict checking. Ownership is
  still `claimed_by_user_id`. A support `IDENTITY_LINK` of a CLINIC person grants the account no
  visibility of the clinic's booking (tested: `404`).
- **Lock order** (extended): idempotency key → clinic `FOR SHARE` → doctor(s) → **identity**
  → person → bookings.
  - `lockIdentityOfPerson` reads the identity, locks it, then locks the person and re-checks.
    If the person moved meanwhile, it retries, up to 3 times, then `409 CONFLICT`.
  - Claims and support links lock: code or case → both identities (ascending) → person rows.

## 3. Link conflicts and correction (ADR-056)

- If two identities already hold overlapping bookings when they are linked, the link
  **succeeds**. Each pair is stored in `identity_link_conflicts` and audited
  (`IDENTITY_LINK_CONFLICT`). **Nothing is cancelled or rescheduled.** The claim response
  reports `identityConflicts`.
- Confirming either booking gives `409 PATIENT_CONFLICT` while the other still holds time
  (tested both ways). After one is cancelled, the other confirms.
- `GET /admin/identity-link-conflicts?status=OPEN|ALL` shows a conflict as OPEN while both
  bookings hold time. `POST …/:id/resolve { note }` records the support outcome.
- **Correction:** `POST /admin/identity-links/:id/revoke { reason, releaseOwnership? }`.
  - The person returns to its origin identity, and the link becomes `REVOKED` with actor and
    reason.
  - If the person was linked differently since, the revoke is refused
    (`409 IDENTITY_LINK_SUPERSEDED`).
  - Ownership is kept unless it is released explicitly.
  - Audited as `IDENTITY_LINK_REVOKED`. A second revoke is `409`.

## 4. Support cases (extends ADR-050)

- `POST /me/identity-cases { kind?, statement, bookingReference? }`. The kind is
  `GUEST_OWNERSHIP` (default, unchanged) or `IDENTITY_LINK`. `IDENTITY_LINK` requires
  `bookingReference`, and its candidates are that booking's CLINIC/GUEST persons.
- Resolving with **LINK** now requires `personId` **and** `evidenceType` (`ID_DOCUMENT`,
  `BOOKING_DETAILS`, `CLINIC_ATTESTATION`, `OTHER`).
  - `GUEST_OWNERSHIP`: ownership + link. `IDENTITY_LINK`: link only.
  - The case stores `evidence_type` and `link_id`.
- Self-approval is still `403 SELF_APPROVAL_FORBIDDEN`. Non-admins get `403`. REJECT changes no
  person or link (tested).
- New admin endpoints: `GET /admin/booking-persons/:personId/identity-links`, plus the revoke and
  conflict endpoints above. All need `platform.identity.resolve` (Super Admin, MFA).

## 5. Database

Five new forward-only migrations. Dev was at 69 and is now at 74. No applied migration was
edited.

| Migration        | Change                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `20261112190001` | `booking_identities`                                                                                         |
| `20261112190002` | `booking_persons.identity_id` / `origin_identity_id` (backfill id = person id, NOT NULL, FKs, UNIQUE origin) |
| `20261112190003` | `booking_identity_links` (CHECKs, append-only); backfill of Task 05.1 claims as `MIGRATION_CLAIM`            |
| `20261112190004` | `identity_link_conflicts` (UNIQUE pair per link)                                                             |
| `20261112190005` | `identity_support_cases`: `case_kind`, `evidence_type`, `link_id`                                            |

Details are in [BOOKINGS_SCHEMA.md](../database/BOOKINGS_SCHEMA.md#task-052-migrations-canonical-booking-identity-adr-055056).
The integration harness clears `identity_support_cases.link_id` (a circular reference with
`booking_identity_links.case_id`) before deleting, and deletes the new tables in dependency
order.

## 6. Legacy identity audit (read-only)

[`apps/backend/scripts/audit-booking-identities.sql`](../../apps/backend/scripts/audit-booking-identities.sql)
runs entirely inside `START TRANSACTION READ ONLY`, contains only SELECTs, and prints hash
prefixes only, never phones. Sections:

- **A:** SELF persons holding GUEST-made bookings (old auto-link).
- **B:** SELF persons older than their account.
- **C:** claims without a claim or support audit.
- **D:** multi-person identity groups.
- **E:** `MIGRATION_CLAIM` links.
- **F:** accounts owning more than one person record.
- **G:** unclaimed guests sharing an account's phone hash (signal only).
- **H:** hashes shared across owners (recycled numbers).
- **I:** totals.

**Results (actually run):**

- **Dev (`medibook`), 2026-11-12:** no booking data; every section empty
  (persons/identities/links/conflicts = 0/0/0/0).
- **Validation** in the disposable test database: synthetic anomalies were seeded (an old
  auto-link shape, a SELF person older than its account, a claim without audit, and a same-phone
  unclaimed guest). Every section reported its seeded case: A, B, C, D, F, G and H one row
  each; E empty (no backfilled links); totals 4/4/1/0.
- **Read-only guard:** an `UPDATE` inside `START TRANSACTION READ ONLY` failed with
  `ERROR 1792 … Cannot execute statement in a READ ONLY transaction`.

The review procedure is in
[BOOKING_PERSONS.md § Legacy identity audit](../platform/BOOKING_PERSONS.md#legacy-identity-audit).
It has two reviewers, and nothing is unlinked or merged from the audit; corrections are separate,
reviewed changes.

## 7. Tests (actually executed)

New file `tests/integration/bookings/canonical-identity.test.ts` with 11 tests:

| Test                                                                                                                 | Result |
| -------------------------------------------------------------------------------------------------------------------- | ------ |
| claim links identities; person ids, bookings, profiles and history unchanged; one link; repeat claim adds none       | ✅     |
| invalid claim and phone equality never link                                                                          | ✅     |
| linked identities can't overlap across clinics (pending holds count); non-overlap allowed; availability agrees       | ✅     |
| pre-existing overlap → conflict recorded and audited, nothing cancelled, confirmation blocked until one is cancelled | ✅     |
| rescheduling checks the canonical identity                                                                           | ✅     |
| support `IDENTITY_LINK` of a staff-recorded CLINIC person: evidence required, link without access                    | ✅     |
| non-admin and self-approval refused; REJECT changes nothing                                                          | ✅     |
| revoking an erroneous link restores separation and keeps history and ownership                                       | ✅     |
| 3 concurrency tests (below)                                                                                          | ✅     |

One existing test was changed: the Task 05.1 support LINK test in `identity.test.ts` now sends
`evidenceType: 'BOOKING_DETAILS'`. The evidence type is a new requirement of this task, so the
test is not weakened.

| Suite                                 | Result                                 |
| ------------------------------------- | -------------------------------------- |
| `bookings/canonical-identity.test.ts` | ✅ 11 passed                           |
| `npm run test:bookings`               | ✅ 8 files, **70 passed** (59 + 11)    |
| `npm test` (unit)                     | ✅ 24 files, **237 passed**            |
| `npm run test:integration`            | ✅ 32 files, **301 passed** (290 + 11) |

**Concurrency** (competing operations → successes):

| Race                                                                                | Competitors | Successes | Others / invariant                                                                                              |
| ----------------------------------------------------------------------------------- | ----------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| bookings for two **linked** person records, same time, three clinics (2 per clinic) | 6           | **1**     | 5 × `PATIENT_CONFLICT`                                                                                          |
| claim (link) racing a booking that overlaps the guest's booking, 8 rounds           | 2 per round | claim 8/8 | booking first: 201 + 1 conflict record; link first: `PATIENT_CONFLICT` + 0 records; never an unrecorded overlap |
| accounts claiming one guest code                                                    | 4           | **1**     | one link row                                                                                                    |

**About the claim race.** When both requests start at the same moment, the claim always wins: the
booking path does more work before it reaches the identity lock. My first version of the test
also built the booking request after the claim was already in flight, so it never really raced.
The test now:

- builds the request body first;
- staggers the claim start by 0–140 ms across rounds;
- checks the invariant (every overlapping holding pair inside one identity has a conflict
  record) in every round.

In two observed runs, 4–5 of 8 rounds were booking-first and 3–4 were link-first. The test does
**not** assert this distribution, because that would make it depend on timing
(TESTING_GUIDELINES rule 6). The booking-first path is also covered deterministically by the
sequential conflict test.

**Mutation checks (performed, then restored; restores verified by `diff`):**

| Mutation                                                                  | Result                               |
| ------------------------------------------------------------------------- | ------------------------------------ |
| conflict query by `origin_identity_id` (each person its own key, partial) | 5 tests failed                       |
| exact pre-05.2 semantics (identity lock kept, busy check per person)      | six-way race failed 3/3 runs         |
| link never records conflicts                                              | 2 failed (conflict test, claim race) |
| identity row lock removed from `lockIdentityOfPerson`                     | six-way race failed 3/3 runs         |

The first mutation showed that the six-way race alone depended on commit order (it passed when
the SELF request happened to win). That is why the second, exact mutation was added.

## 8. Format, lint, typecheck, build and migrations

- `npm run format:check` ✅ · `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm run migrate`: `count: 0` (already applied). `migrate:status`: **74 applied, 0 pending**.
- Dev vs test catalog dump (columns, indexes, CHECKs, FKs): **identical** (1,405 lines).
- **Fresh scratch schema** built from all 74 files: catalog **identical** to dev; 62 tables and
  82 role grants, as in dev; dropped afterwards.
  - The first attempt differed only by `_latin1` introducers in CHECK and generated-column text.
  - The cause was the `mysql` client's default connection charset.
  - Re-applying the files with `--default-character-set=utf8mb4`, which matches the application
    runner, gave an identical catalog. No migration was involved.

## 9. Remaining limitations

- **Untested paths:**
  - `releaseOwnership: true` on revoke;
  - the `IDENTITY_LINK_SUPERSEDED` refusal;
  - `POST /admin/identity-link-conflicts/:id/resolve` (resolved status is tested only as the
    computed state after a cancellation).
- **Revoke has no self-approval guard.** A Super Admin could revoke a link of their own person.
  Case resolution does have the guard. I recommend adding it in review.
- **Staff-recorded patients** stay separate identities until a support `IDENTITY_LINK`. Until
  then the same human can hold an overlapping appointment elsewhere, because there's no proof to
  link on.
- **Database second line** is still per person record. The identity rule is enforced in code
  under the identity lock.
- **Support tooling** has one approver; dual approval and appeals remain OD-27.
- The legacy audit is a manual SQL script, not an admin endpoint or scheduled report.

## 10. Decisions and deviations

- ADR-055 (canonical booking identity, distinct from medical identity; lock order extension) and
  ADR-056 (link conflicts recorded, not cancelled; correction by revocation). **OD-30 resolved.**
- New audit actions: `IDENTITY_LINKED`, `IDENTITY_LINK_CONFLICT`, `IDENTITY_LINK_REVOKED`.
- Support LINK now requires an evidence type (an intended behaviour change).
- Docs updated: BOOKING_PERSONS.md, BOOKINGS.md, BOOKINGS_API.md, BOOKINGS_SCHEMA.md,
  DECISIONS.md, TESTING_GUIDELINES.md, docs/README.md and the task index (05.1 → "Correction 05.2
  issued").

## 11. Exact commands

```bash
npm run migrate && npm run migrate:status && npm run migrate         # 74 applied, 0 pending, count 0
npx vitest run --config vitest.integration.config.ts tests/integration/bookings/canonical-identity.test.ts   # in apps/backend
npm run test:bookings
npm test
npm run test:integration
npm run format:check && npm run lint && npm run typecheck && npm run build
docker exec -i medibook-mysql-1 sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --table medibook' \
  < apps/backend/scripts/audit-booking-identities.sql                # read-only audit (dev)
# schema parity: information_schema catalog dump medibook vs medibook_test → diff (identical)
# fresh build: all 74 files (utf8mb4 client) into a scratch schema → identical catalog, 62 tables, 82 grants → dropped
```
