# Ownership transfer

> **Purpose:** how ownership of a clinic moves from one account to another, and exactly what
> changes and what does not (ADR-031, confirmed in Task 03.1).

```
owner initiates ──▶ PENDING_ACCEPTANCE ──recipient accepts──▶ PENDING_REVIEW ──admin approves──▶ COMPLETED
                         │ decline → DECLINED                        │ reject → REJECTED
                         │ owner cancel → CANCELLED                  │ owner cancel → CANCELLED
                         └ acceptance window passes → EXPIRED
```

| Step                  | Who                                                                           | Rules                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initiate              | an ACTIVE owner of the clinic (`clinic.lifecycle.manage` + CLINIC_OWNER role) | The clinic is ACTIVE or SUSPENDED. The recipient phone must belong to an **ACTIVE account with a verified phone**, other than the initiator. One open transfer per clinic (DB unique key). Initiation records the owner's explicit approval. |
| Accept / decline      | the recipient only                                                            | Within `ownership_transfer.acceptance_ttl_hours` (default 14 days), otherwise `410 TRANSFER_EXPIRED`.                                                                                                                                        |
| Documents             | either party                                                                  | Private; a `TRANSFER_AGREEMENT` document is mandatory for approval.                                                                                                                                                                          |
| Identity verification | Super Admin (`platform.ownership.review`), not a party                        | Records VERIFIED or FAILED, the note, who and when.                                                                                                                                                                                          |
| Approve / reject      | Super Admin, not a party                                                      | Requires PENDING_REVIEW, identity VERIFIED and the agreement document. The clinic must not be CLOSING or CLOSED, and the recipient must still be active and verified.                                                                        |

## Atomic completion (one transaction, clinic row locked first)

1. Re-check every condition. The initiator must still be an active owner.
2. **Terminate all of the previous owner's memberships in this clinic** (every role), with history
   and audit, and clear their remembered context for this clinic.
3. Give the recipient CLINIC_OWNER for all branches, by inserting a new membership or
   reactivating their existing owner row as a **new, open-ended period** (no stale dates; the
   previous period goes to the audit log; ADR-039).
4. Mark the transfer COMPLETED, with history, audit and outbox (`ownership_transfer.completed`).

### What happens to the previous owner (ADR-031, confirmed in Task 03.1)

- **Revoked in this clinic:** CLINIC_OWNER **and every other role** they held here (for example
  a DOCTOR or CLINIC_MANAGER membership). Each one is set to TERMINATED, with history and
  audit. Their remembered clinic context is cleared, so the next request to this clinic gets
  `CLINIC_ACCESS_DENIED`.
- **Untouched:** the account and its status, phone, MFA, sessions and refresh tokens, global
  roles (for example PATIENT), their doctor profile, and **memberships in every other clinic**,
  including clinics they own.
- **Coming back:** the new owner may later grant them a **new** role through the normal
  authorized workflow, an invitation (`clinic.memberships.manage`; never CLINIC_OWNER, see
  ADR-030). On acceptance the terminated row for that role is reactivated as a new period
  (open-ended, with branch scope and branches taken from the invitation, a new history event,
  and the previous period recorded in the audit log; ADR-039). Nothing from the old
  ownership carries over. Handing back ownership itself requires a new ownership transfer.
- Tested in `ownership-transfer.test.ts` (_revokes all of the previous owner's roles here only;
  the new owner can re-invite them with a new role_).
  **Never transferred:** credentials, sessions, MFA, or memberships in other clinics. Clinic data and
  history are unchanged. Concurrent approvals serialize on the locks, so exactly one succeeds and
  the other gets 409 (tested). Starting closure cancels any open transfer.

History: `clinic_ownership_transfer_history` (INITIATED, ACCEPTED, DECLINED, IDENTITY_VERIFIED,
IDENTITY_FAILED, COMPLETED, REJECTED, CANCELLED, CANCELLED_BY_CLOSURE, EXPIRED).
