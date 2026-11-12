# Clinic memberships and staff

> **Purpose:** clinic staff memberships, invitations, role changes and their rules.

Task 02's membership model is extended, not replaced: one row per clinic × user × role,
independent of the global account.

## Statuses

```
PENDING → ACTIVE | TERMINATED
ACTIVE → SUSPENDED | INACTIVE | TERMINATED
SUSPENDED → ACTIVE | INACTIVE | TERMINATED
INACTIVE (deactivated, reversible) → ACTIVE | TERMINATED
TERMINATED → ACTIVE (re-hire)
```

- Changes go through `MembershipService.changeStatus`, which enforces the Task 02 escalation
  rules: no self-changes; clinic actors may manage only roles in `ASSIGNABLE_CLINIC_ROLES`;
  owners are platform-managed.
- Every change writes `clinic_membership_events` and an audit event, and takes effect on the next request.
- **Last-owner protection:** an ACTIVE owner membership cannot leave ACTIVE if it is the last
  one (`409 LAST_ACTIVE_OWNER`). Use an ownership transfer instead. All membership changes
  lock the clinic row, so concurrent changes (for example, two owners removing each other)
  are serialized; tested.
- **Outstanding responsibilities:** `MembershipPolicyHooks.outstandingResponsibilities`. Future
  modules (bookings, queue) report work to reassign; a non-empty list returns
  `409 OUTSTANDING_RESPONSIBILITIES`. No module reports any work yet.
- **Capacity:** activating a member who is not yet active checks the plan limit `max_active_members`.
- Terminating in one clinic leaves other clinics, the account and sessions intact; only
  that clinic's remembered context is cleared.

## Invitations (the only path for clinic actors to add people)

1. `POST /clinic/invitations { phone, role, branchScope, branchIds }` (`clinic.memberships.manage`).
   - Role must be invitable (CLINIC_MANAGER, DOCTOR or RECEPTIONIST; **CLINIC_OWNER never**,
     enforced by a DB CHECK) and assignable by the inviter's role.
   - No self-invites, no duplicate pending invitation, no invitation for a role the person
     already holds.
   - Branches must belong to the clinic (composite FKs as well); the plan limit is checked.
   - A 256-bit token is generated; only its SHA-256 hash is stored. The token is **returned once
     to the inviter** for delivery (notification integration is a later task). Expiry is
     `invitation.ttl_hours` (default 7 days).
2. The invitee signs in with the **invited phone**, sees `GET /me/invitations` (no tokens), then calls
   `POST /invitations/accept { token }` or `/decline`.
3. **Acceptance re-validates everything from the stored invitation:**
   - status PENDING, not expired, and phone match;
   - the clinic is active or suspended (not closing or closed);
   - **the inviter still holds the authority** for that role;
   - the plan capacity.

   - the bound branches still belong to the clinic.

   It creates or reactivates the membership with the bound role and branches. Every
   failure returns the same `404 INVITATION_INVALID`. Acceptance locks the **clinic row first**,
   then the invitation (ADR-034), so concurrent acceptances of one token yield exactly one
   membership, and an acceptance racing a closure approval cannot deadlock (both tested).

4. Revocation: `POST /clinic/invitations/:id/revoke`. A closing clinic revokes all pending invitations.

Tokens and hashes never appear in logs, audit metadata, outbox payloads or API listings
(phones are masked).

## Membership periods and re-granting (ADR-039, Task 03.2)

The unique key `(clinic_id, user_id, role_code)` keeps one row per role. A person who held the
role before gets the same row back, but always as a **new period**:

| Path                                                                      | Effective window after                                                                            | Previous period kept in                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| invitation accepted over a TERMINATED, SUSPENDED, INACTIVE or PENDING row | reset to open-ended (`effective_from/until = NULL`), `activated_at = now`, `terminated_at = NULL` | `MEMBERSHIP_CREATED` audit metadata: `reactivated: true, previousPeriod {status, branchScope, branchIds, effectiveFrom, effectiveUntil, activatedAt, terminatedAt}` |
| invitation accepted over an ACTIVE row whose `effective_until` has passed | same as above (the ended period no longer "holds" the role, so the invitation is allowed)         | same                                                                                                                                                                |
| re-hire via status change TERMINATED → ACTIVE                             | reset to open-ended                                                                               | `MEMBERSHIP_STATUS_CHANGED` metadata `previousPeriod`                                                                                                               |
| ownership transfer reactivating the recipient's old owner row             | reset to open-ended                                                                               | `MEMBERSHIP_CREATED` metadata `previousPeriod`                                                                                                                      |
| resume: SUSPENDED or INACTIVE → ACTIVE via status change                  | **unchanged** (same period continues)                                                             | n/a                                                                                                                                                                 |

Every transition is also in `clinic_membership_events` (append-only), so the timeline of every
period stays reconstructable. Re-granting never touches the person's other clinics or their
account. A currently effective ACTIVE membership still blocks a duplicate invitation (`409`).

## Branch assignments

`PUT /clinic/members/:id/branches { branchScope, branchIds }`. ALL means no ids; ASSIGNED
needs at least one id, and every id must belong to the clinic (otherwise 400). Assignments
never add permissions beyond the role.

**Direct grants** (`MembershipService.grant`) remain a platform-only path
(`platform.memberships.manage`), used for example to appoint an additional owner.
