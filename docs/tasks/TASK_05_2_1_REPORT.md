# Task 05.2.1 report: Canonical identity link lifecycle hardening

> **Purpose:** what Task 05.2.1 found, changed, tested and left open. It completes the Task 05.2
> review items: self-approval on revocation, the revocation, supersede and conflict-resolution
> paths, and the staff-created patient limitation.

| Field  | Value                                  |
| ------ | -------------------------------------- |
| Task   | 05.2.1, correction of Task 05.2        |
| Date   | 2026-11-12                             |
| Status | Awaiting project-owner review          |
| Next   | Owner review. **Task 06 not started.** |

## 1. Findings before this task

1. **Revocation had no self-approval guard.** A Super Admin could revoke a link on their own
   person.
2. **Defect: a link moved the person's whole identity group.** `linkPersonInto` ran
   `UPDATE … WHERE identity_id = <from>`. If a walk-in was already linked to account A, a
   support link of that walk-in to account B would also have moved **A's own SELF person** into
   B's identity. That is an inconsistent identity relationship, and it is the scenario the brief
   asks to test ("replace/supersede with a newer valid link").
3. **No supersede concept.** The only "superseded" state was an identity mismatch, and nothing
   produced it safely.
4. **Conflict resolution was too permissive:**
   - it could be recorded while the overlap was still live;
   - it recorded no method;
   - it had no self-approval guard;
   - a repeat returned `404`;
   - it returned `204` with no body;
   - the list called a merely cleared overlap `RESOLVED`.
5. **Support-case linking read identities before locking them without re-checking.** A
   concurrent revoke could make it fail with a retry error (found by the new race test).

## 2. Changes

**Link semantics (ADR-057, amends ADR-055/056)**

- A link moves **exactly one** GUEST or CLINIC person into an account's identity.
- SELF persons never move (`409 IDENTITY_LINK_NOT_ALLOWED`).
- A person owned by one account is never linked into another account's identity
  (`409 IDENTITY_OWNED_ELSEWHERE`).
- **Supersede:** a newer verified link for an already-linked person marks the previous link
  `SUPERSEDED` (`superseded_by_link_id`, `superseded_at`). The previous account's records stay
  put. At most one link per person is ACTIVE.
- **Locking:** the new `lockIdentitiesOfPersons` locks the current identities of all involved
  persons in ascending order, then the person rows, and re-checks (≤ 3 attempts). Claims and
  support links use it. `linkPersonInto` refuses to act on an identity that the caller has not
  locked.

**Revocation**

- Only an ACTIVE link can be revoked. A SUPERSEDED link gets `409 IDENTITY_LINK_SUPERSEDED`, and
  nothing changes.
- Revoking the current link returns the person to its **own** origin, never to an earlier
  account.
- The audit records the from/to identity, whether ownership was released, and the previous
  owner. The response includes `ownershipReleased`.

**Self-approval** (service level, inside the transaction, under the identity locks)

- A Super Admin is _involved_ when their account owns, as SELF or by claim, a person in, or
  originating from, an affected identity, or when they acted on one of the conflict's bookings.
- An involved admin gets `403 SELF_APPROVAL_FORBIDDEN` for revocation and for conflict
  resolution; the existing case rule is unchanged. Another Super Admin can perform the
  operation. Authorization (`platform.identity.resolve`) is still checked first.

**Conflict resolution** (`POST /admin/identity-link-conflicts/:id/resolve { note }`)

- It is `409 IDENTITY_CONFLICT_STILL_OVERLAPPING` while both bookings hold time in one identity.
- It records `resolved_at`, `resolved_by_user_id`, `resolution_note` and `resolution_method`
  (`BOOKING_RELEASED` | `LINK_REVOKED`), and is audited as `IDENTITY_LINK_CONFLICT_RESOLVED`.
- It never changes a booking.
- **Final:**
  - an identical retry (same actor and note) replays with `alreadyResolved: true` and no new
    effects;
  - anything else gets `409 IDENTITY_CONFLICT_ALREADY_RESOLVED`;
  - there is no reopen.
- It returns `200` with the resolution; this was `204` in 05.2. The list shows `OPEN`,
  `CLEARED` (overlap gone, not recorded) or `RESOLVED`.

**Refusal records:** refused privileged identity operations roll back, then write a `FAILURE`
security event `IDENTITY_OPERATION_REFUSED { operation, targetId, code }`. This covers
self-approval, superseded revoke, live overlap and already resolved.

**Staff-created patients** (section 4 of the brief): there is no code change and no phone-based
linking. The limitation is documented in
[BOOKING_PERSONS.md § Staff-created patients: known limitation](../platform/BOOKING_PERSONS.md#staff-created-patients-known-limitation):

- such a person stays separate;
- conflict detection is guaranteed only within one canonical identity;
- a matching phone is never evidence;
- the future path is verified claim or support linking;
- linking never grants medical access and never merges clinic profiles.

## 3. Database

There is one new forward-only migration. Dev was at 74 and is now at **75**.

`20261112200001_identity_link_lifecycle` adds:

- on `booking_identity_links`: `superseded_by_link_id` (UNIQUE, FK self) and `superseded_at`;
- a status CHECK for ACTIVE / REVOKED (needs a revoker) / SUPERSEDED (needs a successor);
- `identity_link_conflicts.resolution_method`, with a CHECK and backfill `UNRECORDED` for rows
  resolved earlier;
- an all-or-nothing CHECK over the resolution columns.

**Why not amend 190003/190004:** the policy prefers amending unreleased migrations, but only
after rebuilding every database that applied them. That would delete the local dev accounts. A
new migration is always allowed, and it was the non-destructive choice. No applied migration was
edited.

## 4. Tests (actually executed)

**New file:** `tests/integration/bookings/identity-link-lifecycle.test.ts`, with 14 tests. After
**every** test, an `afterEach` checks a global invariant over all persons and links:

- at most one ACTIVE link per person;
- identity equals the active link's target, or the origin when there is none;
- SELF persons never move;
- a linked person is anchored by an account's SELF person;
- a claimed person is only in its owner's identity;
- a superseded link points to a newer link of the same person.

| Area                     | Test                                                                                                                                                                                                                          | Result |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| self-approval (revoke)   | an involved admin is refused (`403`, nothing changes, no revoke audit, 1 refusal event); another admin revokes                                                                                                                | ✅     |
| self-approval (revoke)   | an admin whose identity holds the support-linked walk-in is refused; a patient gets `FORBIDDEN`                                                                                                                               | ✅     |
| `releaseOwnership: true` | origin restored; ownership cleared; bookings, history and profiles identical; audit only appended (exactly 1 new row); link history `REVOKED`; account loses access; conflicts follow the new identities                      | ✅     |
| atomicity                | fault injection (CHECK on the final audit insert) → `500`; identity, ownership and link unchanged; retry succeeds                                                                                                             | ✅     |
| supersede                | 2nd verified link supersedes the 1st and moves only the walk-in; stale revoke `409 IDENTITY_LINK_SUPERSEDED` (no change, 1 refusal event); conflicts follow the current link; revoking the current link returns to the origin | ✅     |
| ownership guard          | a support link of a person owned by another account → `409 IDENTITY_OWNED_ELSEWHERE`; nothing changes; case stays OPEN                                                                                                        | ✅     |
| conflict resolve: access | patient and clinic owner `FORBIDDEN`; involved admin `SELF_APPROVAL_FORBIDDEN` (recorded)                                                                                                                                     | ✅     |
| conflict resolve: live   | `409 IDENTITY_CONFLICT_STILL_OVERLAPPING`; bookings and history byte-identical                                                                                                                                                | ✅     |
| conflict resolve: record | actor, note, time (within the request window) and method `BOOKING_RELEASED`; bookings untouched; 1 audit; identical retry replays (still 1 audit); different note and other admin `409 ALREADY_RESOLVED`; row unchanged       | ✅     |
| conflict after revoke    | `CLEARED`, then resolves as `LINK_REVOKED`; both bookings still pending                                                                                                                                                       | ✅     |
| concurrency              | 4 races (below)                                                                                                                                                                                                               | ✅     |

**Changed existing test:** `canonical-identity.test.ts`. After a cancellation, the conflict now
lists as `CLEARED`, no longer `RESOLVED`. The test then resolves the conflict and asserts
`BOOKING_RELEASED` and `RESOLVED`. This is the intended semantics change, and the test is
stronger than before, not weaker.

| Suite                                        | Result                                 |
| -------------------------------------------- | -------------------------------------- |
| `bookings/identity-link-lifecycle.test.ts`   | ✅ 14 passed                           |
| `npm run test:bookings`                      | ✅ 9 files, **84 passed** (70 + 14)    |
| `npm test` (unit)                            | ✅ 24 files, **237 passed**            |
| `npm run test:integration` (Tasks 01–05.2.1) | ✅ 33 files, **315 passed** (301 + 14) |

**Concurrency** (competing operations → outcomes):

| Race                                                                        | Competitors      | Outcome                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| three admins revoking one link (`releaseOwnership`)                         | 3                | **1** × 200, 2 × 409; 1 revoke audit                                                                                                                                                       |
| revoke racing an overlapping booking, 8 rounds, staggered 0–140 ms          | 2 per round (16) | revoke 8/8 × 200; booking `PATIENT_CONFLICT` when it locked first (6/8 in each of two runs), `201` after the revoke (2/8); never an unrecorded overlap inside one identity                 |
| superseding link racing revoke of the old link, 8 rounds, alternating start | 2 per round (16) | link 8/8 × 200; revoke first → old link `REVOKED`, new link from origin (4/8); link first → revoke `409 IDENTITY_LINK_SUPERSEDED` (4/8); identical in two runs; invariant held every round |
| three admins resolving one cleared conflict                                 | 3                | **1** × 200, 2 × `IDENTITY_CONFLICT_ALREADY_RESOLVED`; 1 resolution audit                                                                                                                  |

The tests assert only order-independent invariants. The distributions above come from two
instrumented runs (logging added temporarily, then removed), because asserting them would make
the tests timing-dependent.

**Mutation checks** (each applied, run against both identity test files, then restored and
verified with `diff`):

| Mutation                                       | Failing tests                       |
| ---------------------------------------------- | ----------------------------------- |
| M1: no self-approval check on revoke           | 2 (both revoke self-approval tests) |
| M2: no self-approval check on conflict resolve | 1                                   |
| M3: allow resolving a live overlap             | 1                                   |
| M4: the old whole-group move                   | 2 (supersede test, supersede race)  |
| M5: old link not marked `SUPERSEDED`           | 2                                   |
| M6: no ownership guard                         | 1                                   |
| M7: no re-check after the identity lock        | 1 (supersede race), in 2 of 2 runs  |

## 5. Verification

- `npm run format:check` ✅ · `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm run migrate`: 1 applied, then a re-run gives `count: 0`. `migrate:status`: **75 applied,
  0 pending**.
- Dev vs test catalog dump (columns, indexes, CHECKs, FKs): **identical** (1,412 lines).
- **Fresh scratch schema** from all 75 files (utf8mb4 client): catalog **identical** to dev;
  62 tables and 82 role grants, as in dev; dropped afterwards.
- The read-only legacy audit script is unchanged and still runs against the new schema (dev: all
  sections empty, totals 0/0/0/0). No historical data was modified or repaired.

## 6. Remaining limitations

- **Staff-created patients** stay separate until a support link (documented, by design). There
  is no clinic-issued claim code yet.
- **Single approver** for support decisions. Dual approval and appeals remain OD-27.
- **A resolution is final.** A wrong note can't be edited; a new support record is needed.
- **Self-approval scope** is account-based: the admin's own SELF or claimed persons and the
  bookings they acted on. It doesn't cover relatives, such as the admin's dependents booked by
  someone else. Those are separate persons with no link to the admin's identity.
- **Released ownership** leaves the guest's claim code `USED`. A new owner needs a
  `GUEST_OWNERSHIP` support case.
- **Refusal events** are written after the rollback, in a separate statement. If that insert
  failed, the request would still be refused, but unrecorded.

## 7. Decisions and deviations

- ADR-057 added; ADR-056 text updated to point at it. No other ADR was changed.
- New audit action `IDENTITY_LINK_CONFLICT_RESOLVED`; a supersede is audited inside
  `IDENTITY_LINKED` (`supersededLinkId`). New audit target type `IDENTITY_LINK_CONFLICT`. New
  security event `IDENTITY_OPERATION_REFUSED`.
- **Behaviour changes:**
  - the conflict-resolve response is now `200` + body (was `204`);
  - the conflict list adds `CLEARED`;
  - support linking of a person owned by another account is refused;
  - links move one person.
- Docs updated: BOOKING_PERSONS.md, BOOKINGS_API.md, BOOKINGS_SCHEMA.md, DECISIONS.md,
  TASK_05_2_REPORT.md (correction notice and status) and the task index.

## 8. Exact commands

```bash
npm run migrate && npm run migrate:status && npm run migrate        # 1 applied → 75/0 → count 0
npx vitest run --config vitest.integration.config.ts tests/integration/bookings/identity-link-lifecycle.test.ts   # in apps/backend
npm run test:bookings
npm test
npm run test:integration
npm run format:check && npm run lint && npm run typecheck && npm run build
docker exec -i medibook-mysql-1 sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --table medibook' \
  < apps/backend/scripts/audit-booking-identities.sql                # read-only audit (unchanged)
# parity: information_schema catalog dump medibook vs medibook_test → diff (identical, 1,412 lines)
# fresh build: all 75 files via mysql --default-character-set=utf8mb4 into a scratch schema → identical, 62 tables, 82 grants → dropped
```
