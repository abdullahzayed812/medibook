# Task 03.2 report: Final platform consistency fixes

| Field  | Value                                                 |
| ------ | ----------------------------------------------------- |
| Task   | 03.2, final consistency fixes before Task 03 approval |
| Date   | 2026-11-11                                            |
| Status | Awaiting project-owner review                         |
| Next   | Owner review. **Task 04 not started.**                |

## A. Summary

1. **ADR-026** was verified cell by cell against the gate, the authorization integration and the
   tests, and the code matches the matrix. One security defect was found and fixed: a Super
   Admin who is also a clinic member could grant **themselves** a continuity-of-care exception.
   ADR-026 and CLINIC_LIFECYCLE.md now describe FULL vs NEW_OPERATIONS, the exception rules and
   the enforcement path precisely.
2. **Membership re-grant dates fixed** for all three reactivation paths (invitation acceptance,
   re-hire, ownership transfer). A re-grant now starts a new, open-ended period, and the
   previous period goes to the audit log. **No schema change, no migration.** While doing this
   I also fixed a lock-order inversion in invitation acceptance (deadlock risk against closure
   approval).
3. **Zero-day trials:** behaviour unchanged, now documented, tested and recorded as
   **ADR-038** (resolves OD-19).

## B. ADR-026 resolution and policy consistency

| Checked                                                                      | Result                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluateClinicOperation` vs the documented matrix (7 states × 6 categories) | identical; unit test `operation-policy.test.ts` asserts every cell                                                                                         |
| `ClinicOperationGateImpl`                                                    | re-reads clinic, open suspension, effective subscription and branch per check (no cache); looks up the exception only for FULL + READ/CONTINUITY           |
| `AuthorizationService.check`                                                 | gate runs after the membership/role decision for **every** CLINIC permission; PLATFORM permissions are not gated (by design)                               |
| Other enforcement paths                                                      | growth: `assertCanGrow` (subscription + plan limits); invitation acceptance re-checks the inviter through the gate, so a FULL suspension blocks acceptance |
| Exceptions                                                                   | `platform.clinics.manage` + MFA, active member only, FULL only, bound to the suspension id, ≤ 72 h, revocable, audited on grant and revoke                 |
| Status independence                                                          | suspension changes neither the subscription nor the registration (now tested); closure completion expiring the subscription is the documented exception    |

**Discrepancies found:**

| #   | Discrepancy                                                                                                                                     | Action                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | **Security:** `grantAccessException` had no separation-of-duties check (registration, doctor verification, closure and transfer all have one)   | **Fixed:** `403 SELF_APPROVAL_FORBIDDEN` when `userId === actor`. Test plus a mutation check. |
| 2   | Docs did not say that exceptions are bound to one suspension, how revocation works, or that a FULL suspension also blocks invitation acceptance | Documented and tested                                                                         |
| 3   | ADR-026 summary omitted NEW_OPERATIONS details, CLOSING, the inactive branch, and the evaluation order                                          | ADR-026 rewritten                                                                             |

**Doc changes:** ADR-026 is now "verified and clarified in Task 03.2" (no longer "needs
approval"). CLINIC_LIFECYCLE.md gains the enforcement path, the evaluation order, a FULL vs
NEW_OPERATIONS table and an exception rules table.

## C. Membership re-invitation fix

**Root cause.** `(clinic_id, user_id, role_code)` is unique, so a re-grant reuses the old row.
All three reactivation paths called `updateStatus`, which keeps the old
`effective_from/effective_until`. Access requires `effective_until > now`, so the re-granted
membership could be ACTIVE but never effective.

**Fix (smallest consistent change, no parallel model, no schema change):**

- `MembershipsRepository.reactivateAsNewPeriod` sets `status = ACTIVE`, clears the window
  (open-ended), sets `activated_at = now` and clears `terminated_at`.
- It is used by `StaffService.accept`, by `MembershipService.changeStatus` for
  TERMINATED → ACTIVE only (resuming SUSPENDED/INACTIVE keeps its window), and by
  ownership-transfer completion for a former owner.
- **History:** the previous period (status, branch scope, branches, effective window, activated
  and terminated times) goes into the audit event's `previousPeriod` in the same transaction.
  `clinic_membership_events` keeps every transition, and its reason is marked "new membership
  period".
- An ACTIVE row whose window has ended no longer counts as "already holds the role". This
  applies both when inviting and when accepting.
- **Acceptance re-checks:** invitation PENDING, unexpired and phone-bound (unchanged); clinic
  status (unchanged); inviter authority through the gate (unchanged); capacity (unchanged); and
  **new:** the bound branches are re-validated.
- **Concurrency:** acceptance now locks the **clinic row first** and then re-reads the
  invitation `FOR UPDATE` (ADR-034 order). Before, it locked the invitation first, the reverse of
  closure approval, so the two could deadlock.

**Schema impact:** none. No migration file was added or changed; 45 applied, 0 pending.

## D. Zero-day trial behaviour (ADR-038)

The behaviour is unchanged.

- **At approval:** stored PAST_DUE, `past_due_since` = approval, no trial or period, history
  `CREATED`.
- **During grace** (default 3 days): the effective status is PAST_DUE in grace, so new
  operations, growth and the Marketplace subscription criterion are **allowed**.
- **After grace:** effectively SUSPENDED even without the sweep. New operations and growth get
  403, the clinic leaves the Marketplace, and reads, care and administration remain.
- **Activation:** a Super Admin records the payment (`POST /admin/clinics/:id/subscription/payments`),
  which makes the subscription ACTIVE for one billing cycle.
- **No unpaid window:** set a per-clinic grace of 0, which blocks immediately (tested).

**Does it grant access without payment?** Only during the bounded, configurable grace period.
That is the same rule a late-paying clinic gets, and ADR-028 already documented it, so it is not
accidental. If you want "no access before the first payment" as the default, that is a product
change (a special case in `effectiveSubscription`). I did not make it. ADR-038 records the
decision for your confirmation.

## E. New and updated tests

| File                                                | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform/membership-reinvitation.test.ts` (new, 6) | (1+2+3) terminated member with a past end date re-invited → accepted → open-ended, effective, access 200; (4) events ACTIVE→TERMINATED→ACTIVE plus audit `previousPeriod`; (5) other-clinic membership and account byte-identical; ACTIVE-but-expired renewable, and an effective one still 409; re-hire resets the window while resume keeps it; (6) expired, revoked and already-used → `INVITATION_INVALID`; (7) 5 parallel acceptances → exactly 1 membership; acceptance racing closure approval ends consistently without 5xx |
| `platform/clinic-lifecycle.test.ts` (+2)            | revocation effective on the next request plus audit; exception void after reinstate and re-suspend; self-grant `SELF_APPROVAL_FORBIDDEN` while another admin can grant; NEW_OPERATIONS keeps administration, reads and care, exceptions get 409, statuses independent                                                                                                                                                                                                                                                               |
| `platform/subscriptions.test.ts` (+1)               | zero-day trial: PAST_DUE / `CREATED`; allowed in grace (including the Marketplace criterion); blocked after grace with reads kept; payment activates; owner cannot pay; grace 0 blocks immediately                                                                                                                                                                                                                                                                                                                                  |

**Mutation checks (performed, then restored):** making reactivation keep the old window broke
2 re-invitation tests. Disabling the self-grant guard broke the self-grant test.

The lock-order race test passes consistently. It cannot deterministically reproduce the old
deadlock, which is timing-dependent.

## F. Commands executed and results

| Command                                                                                                                                     | Result                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `vitest --config vitest.integration.config.ts …/membership-reinvitation.test.ts`                                                            | ✅ 5 passed (6 after adding the re-hire test)     |
| same, with reactivation mutated to keep the old window                                                                                      | ✅ detected: 2 failed; restored                   |
| `vitest … …/clinic-lifecycle.test.ts`                                                                                                       | ✅ 11 passed                                      |
| same, with the self-grant guard disabled                                                                                                    | ✅ detected: 1 failed; restored                   |
| `vitest … …/subscriptions.test.ts`                                                                                                          | ✅ 7 passed                                       |
| `vitest … membership-reinvitation staff-invitations ownership-transfer`                                                                     | ✅ 25 passed                                      |
| `npm run format:check`                                                                                                                      | ✅ (after `prettier --write` on 4 changed files)  |
| `npm run lint`                                                                                                                              | ✅                                                |
| `npm run typecheck`                                                                                                                         | ✅                                                |
| `npm run build`                                                                                                                             | ✅                                                |
| `npm test` (unit, incl. `operation-policy`, `evaluate`, `catalog`, `policy`, `permissions`)                                                 | ✅ 21 files, **213 passed**                       |
| `npm run test:integration` (all Task 02 and Task 03 suites: authorization, tenant isolation, auth, security, api, platform, infrastructure) | ✅ 20 files, **199 passed** (Task 03.1: 19 / 190) |
| `npm run migrate:status`                                                                                                                    | ✅ 45 applied, 0 pending (unchanged)              |
| link check over all docs                                                                                                                    | ✅ 224 references; only the known 140007 comment  |

## G. Remaining known issues

1. **ADR-038 needs your confirmation.** A zero-trial clinic can operate for the grace period
   before paying, unless its grace is set to 0.
2. **Invitations during CLOSING:** ADMINISTRATION is allowed while CLOSING, so a new invitation
   can be created, but acceptance requires ACTIVE or SUSPENDED and therefore always fails. This
   is harmless but confusing. The fix is a one-line clinic-status check in `StaffService.invite`.
   Not changed, because it is behaviour outside this brief.
3. The previous membership period's window is kept in audit metadata, not in a queryable
   periods table (ADR-039 trade-off).
4. The migration `20261111140007` comment still names an old doc path (unchanged from 03.1, to
   keep its checksum).

## H. Changed files

Code:

- `access/tenancy/memberships.repository.ts` (`reactivateAsNewPeriod`, `isPeriodEnded`,
  `membershipPeriod`)
- `access/index.ts` (exports)
- `access/tenancy/membership.service.ts` (re-hire)
- `staff/staff.service.ts` (accept: lock order, branch re-check, new period, audit; invite:
  ended-window rule)
- `ownership-transfer/ownership-transfer.service.ts` (new period for a former owner)
- `clinics/lifecycle.service.ts` (self-grant guard)

Tests: the three files in E.

Docs:

- `CLINIC_LIFECYCLE.md`, `CLINIC_MEMBERSHIPS.md`, `SUBSCRIPTION_MANAGEMENT.md`,
  `OWNERSHIP_TRANSFER.md`, `CLINIC_REGISTRATION.md`
- `DECISIONS.md` (ADR-026, ADR-028, ADR-034 updated; ADR-038, ADR-039 added; OD-19 resolved)
- the tasks index and this report
