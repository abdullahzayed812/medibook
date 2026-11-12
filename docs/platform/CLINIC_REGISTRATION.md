# Clinic registration

> **Purpose:** the workflow, rules and approval behaviour for an applicant's request to open a
> clinic on the platform. What happens to a clinic after approval is in
> [CLINIC_LIFECYCLE.md](CLINIC_LIFECYCLE.md).

## Workflow

```
DRAFT ──submit (applicant)──▶ PENDING_REVIEW ──start-review──▶ UNDER_REVIEW ──approve──▶ APPROVED
                                   ▲                              │  │
                                   └──resubmit── NEEDS_INFORMATION ◀─┘  └──reject──▶ REJECTED
PENDING_REVIEW / UNDER_REVIEW / NEEDS_INFORMATION ──suspend──▶ SUSPENDED ──resume──▶ UNDER_REVIEW
                                                                    └──reject──▶ REJECTED
```

| Transition                                                 | Actor       | Reason                                   |
| ---------------------------------------------------------- | ----------- | ---------------------------------------- |
| DRAFT → PENDING_REVIEW, NEEDS_INFORMATION → PENDING_REVIEW | applicant   | —                                        |
| PENDING_REVIEW → UNDER_REVIEW                              | Super Admin | optional                                 |
| UNDER_REVIEW → NEEDS_INFORMATION / REJECTED                | Super Admin | **required**                             |
| UNDER_REVIEW → APPROVED                                    | Super Admin | optional (plan + billing cycle required) |
| → SUSPENDED, SUSPENDED → UNDER_REVIEW / REJECTED           | Super Admin | **required**                             |

APPROVED and REJECTED are final.

## Registration `SUSPENDED` (ADR-027, confirmed in Task 03.1)

**Meaning:** a Super Admin has **frozen the review** of a request that has not been decided,
for example because of suspected fraud, a legal hold or a pending external check. It says
nothing about a clinic, because no clinic exists until approval.

| From                                            | To           | Who         | Reason   |
| ----------------------------------------------- | ------------ | ----------- | -------- |
| PENDING_REVIEW, UNDER_REVIEW, NEEDS_INFORMATION | SUSPENDED    | Super Admin | required |
| SUSPENDED                                       | UNDER_REVIEW | Super Admin | required |
| SUSPENDED                                       | REJECTED     | Super Admin | required |

Not reachable from DRAFT, APPROVED or REJECTED. SUSPENDED → APPROVED is not allowed directly:
the review must resume first, so approval always starts from UNDER_REVIEW.

**While SUSPENDED (tested):**

| Operation                                    | Effect                                |
| -------------------------------------------- | ------------------------------------- |
| Applicant edits fields or uploads documents  | blocked (`REGISTRATION_NOT_EDITABLE`) |
| Applicant submits or resubmits               | blocked (`INVALID_TRANSITION`)        |
| Super Admin approves or requests information | blocked (`INVALID_TRANSITION`)        |
| Super Admin resumes or rejects               | allowed, with a reason                |
| Applicant and reviewers read the request     | allowed                               |
| Per-account open-request limit               | still counts as an open request       |
| Clinic, branch, membership or subscription   | none exists                           |

### Three independent status dimensions

| Dimension               | Stored in                                                         | Exists                 | Changed by                                                                         |
| ----------------------- | ----------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| **Registration status** | `clinic_registration_requests.status`                             | before and at approval | the registration workflow only. Final once APPROVED/REJECTED.                      |
| **Operational status**  | `clinics.operational_status` (ACTIVE, SUSPENDED, CLOSING, CLOSED) | after approval         | the clinic lifecycle ([CLINIC_LIFECYCLE.md](CLINIC_LIFECYCLE.md))                  |
| **Subscription status** | `clinic_subscriptions` (stored + effective)                       | after approval         | subscription management ([SUBSCRIPTION_MANAGEMENT.md](SUBSCRIPTION_MANAGEMENT.md)) |

- Registration `SUSPENDED` and operational `SUSPENDED` share a word and nothing else. Suspending
  a clinic never touches its (already APPROVED) registration, and suspending a registration
  cannot affect any clinic.
- Operational suspension does not change the subscription, and subscription restriction does
  not change the operational status. The operation gate evaluates both, and the most
  restrictive applies.
- The only cross-effects are explicit lifecycle consequences: **approval** initializes the
  operational status (ACTIVE) and the subscription, and **closure completion** expires the
  subscription.

## Rules

- Any authenticated active account may create drafts (limit:
  `registration.max_open_requests_per_user`, default 3).
- Applicants can edit fields and documents only in DRAFT and NEEDS_INFORMATION.
- **Submission requires:** contact phone or email, address line 1, city, country, legal name,
  business registration number and at least one document. Otherwise `422 REGISTRATION_INCOMPLETE`.
- Reviewers never see DRAFTs. **A reviewer can never decide on their own registration**
  (`403 SELF_APPROVAL_FORBIDDEN`), and non-admins have no review access.
- Every transition writes `clinic_registration_review_history` (actor, from, to, reason,
  timestamp), `audit_events` and an outbox event (`registration.*`).

## Approval (one transaction)

1. Lock the request, verify UNDER_REVIEW, the reviewer is not the applicant, and the applicant
   account is ACTIVE with a verified phone.
2. Create the **clinic** (copied fields; `operational_status = ACTIVE`, `approved_at`, `approved_by`).
3. Create the **main branch** from the registration address (time zone `UTC`; editable).
4. Create the applicant's **CLINIC_OWNER membership** (all branches) and its history event.
5. Create the **subscription** for the chosen plan: TRIAL if the plan version has trial days,
   otherwise PAST_DUE (payment due now; the grace period applies).
6. Mark the request APPROVED with `clinic_id`, plus history, audit (`CLINIC_CREATED`,
   `MEMBERSHIP_CREATED`, `SUBSCRIPTION_CREATED`) and outbox (`clinic.approved`).

Nothing operational exists before this commits, so an unapproved clinic cannot operate or
appear in the Marketplace.

### Failure and retry (ADR-028, confirmed in Task 03.1)

- All six steps run in **one database transaction**. The only effects outside the database are
  the outbox row and the audit rows, which are part of the same transaction. No external call,
  file move or queue publish happens during approval.
- **Any failure rolls everything back.** Examples: an unavailable plan, an applicant account
  that became inactive, a constraint violation or a lost connection. No clinic, branch,
  membership, subscription, history, audit or outbox row remains, and the request stays
  UNDER_REVIEW with no `clinic_id`. A test forces a failure after the clinic, branch and owner
  rows were inserted and checks that nothing remains.
- **Retry** is a plain re-submission of the approval once the cause is fixed. It starts from
  the same UNDER_REVIEW state.
- **Exactly once:** the request row is locked (`FOR UPDATE`) before anything is created. A
  second or concurrent approval sees APPROVED and gets `409 INVALID_TRANSITION`, so a clinic can
  never be created twice for one request.
- **Subscription initialization:** TRIAL when the selected plan version has trial days,
  otherwise PAST_DUE (payment due now; the grace period applies). Zero-trial behaviour and how such a
  subscription is activated: [SUBSCRIPTION_MANAGEMENT.md](SUBSCRIPTION_MANAGEMENT.md#plans-with-zero-trial-days-adr-038)
  (ADR-038)..

## Documents

Types: BUSINESS_LICENSE, FACILITY_LICENSE, OWNER_IDENTITY, TAX_CERTIFICATE, OTHER. Access is
limited to the applicant and reviewers. Documents are addressed only through
(registration id, document id), so manipulated ids return 404. Reviewer downloads are audited
(`DOCUMENT_ACCESSED`), and removal is soft.
