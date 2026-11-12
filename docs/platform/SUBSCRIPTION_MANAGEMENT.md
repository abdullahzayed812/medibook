# Subscription management

> **Purpose:** SaaS plans, clinic subscriptions, their statuses and how they restrict operations.

The platform bills **clinics** for SaaS subscriptions. Patient payments to clinics are out of scope.

## Plans

- `subscription_plans` (code, name, description, ACTIVE/INACTIVE) plus **immutable**
  `subscription_plan_versions` (monthly and annual price in minor units, currency, trial days,
  features, limits).
- Changing terms creates a new version. Existing subscriptions keep the version they were
  sold, and `current_version_id` applies to new assignments.
- **Features and limits** are validated by strict zod schemas (`subscriptions/policy.ts`). Every
  version must define every key, unknown keys are rejected, and code never hardcodes plan values:
  - `features.marketplace_listing` (boolean)
  - `limits.max_branches`, `limits.max_active_members` (integer ≥ 1, or `null` = unlimited)
- Public `GET /plans` lists active plans with current terms. Management requires
  `platform.plans.manage`.

## Lifecycle

Stored statuses: TRIAL, ACTIVE, PAST_DUE, SUSPENDED, EXPIRED.

| From                                | To                  | Trigger                                                                                |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| (none)                              | TRIAL / PAST_DUE    | registration approval (TRIAL if the plan has trial days; otherwise payment is due now) |
| TRIAL, PAST_DUE, SUSPENDED, EXPIRED | ACTIVE              | payment recorded (new period from now)                                                 |
| ACTIVE (in period)                  | ACTIVE              | payment recorded = renewal (period extended from its end)                              |
| TRIAL                               | EXPIRED             | sweep: trial ended                                                                     |
| ACTIVE                              | PAST_DUE            | sweep: period ended unpaid (`past_due_since` = period end)                             |
| PAST_DUE                            | SUSPENDED           | sweep: grace period expired (`GRACE_EXPIRED`)                                          |
| any non-final                       | SUSPENDED / EXPIRED | Super Admin                                                                            |
| SUSPENDED                           | ACTIVE or PAST_DUE  | Super Admin reactivation (ACTIVE only if the paid period is still running)             |
| any                                 | (plan change)       | Super Admin; new plan version, history keeps the old one                               |

### Plans with zero trial days (ADR-038)

A plan version with `trial_days = 0` has no trial. On approval the subscription is created as:

| Field                                         | Value                                   |
| --------------------------------------------- | --------------------------------------- |
| stored status                                 | `PAST_DUE` (payment is due immediately) |
| `trial_starts_at` / `trial_ends_at`           | `NULL`                                  |
| `current_period_start` / `current_period_end` | `NULL` (nothing has been paid yet)      |
| `past_due_since`                              | the approval time                       |
| history event                                 | `CREATED` (never `TRIAL_STARTED`)       |

What the clinic can do (all tested in `subscriptions.test.ts`):

1. **During the grace period** (`subscription.grace_period_days`, default 3 days, or the clinic
   override), the effective status is PAST_DUE in grace, so `permitsNewOperations = true`. New
   operations, growth actions and the subscription criterion of Marketplace eligibility are
   allowed. This is the same grace a paying clinic gets when a renewal is late, and it is the
   **only** unpaid window a zero-trial clinic gets.
2. **When the grace period ends**, the effective status is SUSPENDED immediately, even before the
   sweep runs (date-derived). New operations and growth get `403 SUBSCRIPTION_INACTIVE`, and the
   clinic leaves the Marketplace (`SUBSCRIPTION_NOT_ELIGIBLE`). Reads, continuity of care,
   administration and lifecycle actions remain. No data or membership changes.
3. **Activation:** a Super Admin (`platform.subscriptions.manage`, MFA) records the payment with
   `POST /admin/clinics/:id/subscription/payments { billingCycle?, reference? }`. The
   subscription becomes ACTIVE with a period from now to now + one billing cycle, and
   `past_due_since` is cleared. History records `ACTIVATED`, and audit and outbox events are
   written. Operations are allowed again on the next request. This works from PAST_DUE and from
   (effective or stored) SUSPENDED. Clinic users cannot record payments.

To give a zero-trial clinic **no** unpaid access at all, a Super Admin sets its grace override
to 0 days right after approval
(`PUT /admin/clinics/:id/subscription/grace-period { days: 0, reason }`). The subscription is
then effectively SUSPENDED immediately, and new operations are blocked until payment (tested).

**Grace period:** platform setting `subscription.grace_period_days` (default **3**, 0–60), with an
optional per-clinic override. Both are changed only by a Super Admin and are audited.

## Consistency strategy

The stored status is updated by admin actions, payments and the worker's **lifecycle sweep**
(BullMQ job scheduler, every 15 minutes, idempotent, row-locked). **Enforcement never trusts the stored status alone.**
`effectiveSubscription(state, now)` derives the effective status from dates (an expired trial
counts as EXPIRED, an ACTIVE subscription past its period end as PAST_DUE, a PAST_DUE one past
its grace as SUSPENDED). A lagging sweep therefore never extends access.

## Enforcement policy (central)

When the effective subscription does not permit new operations (NONE, EXPIRED, SUSPENDED, or
PAST_DUE beyond grace):

- **Blocked:** NEW_OPERATION permissions (bookings, new patients…) through the clinic operation
  gate on every route; growth actions (create or reactivate a branch, create or accept an
  invitation) through `assertCanGrow`. Response: `403 SUBSCRIPTION_INACTIVE`.
- **Still allowed:** reading existing records, continuity of care, administration, lifecycle
  requests, viewing the subscription.
- **Never happens:** data deletion, membership termination, or a change to the operational status.
- Marketplace participation stops (see MARKETPLACE_ELIGIBILITY.md).

Plan limits (`PLAN_LIMIT_REACHED`) apply even in good standing.

## History and billing seam

`clinic_subscription_history` is append-only and records every event: CREATED, TRIAL_STARTED,
ACTIVATED, RENEWED, PLAN_CHANGED, MARKED_PAST_DUE, GRACE_EXPIRED, TRIAL_ENDED, SUSPENDED,
REACTIVATED, EXPIRED and GRACE_PERIOD_CHANGED. Each row holds the statuses, plan versions,
billing cycle and period, actor and reason.

Every change also writes audit (before/after) and an outbox event (`subscription.*`).
**No payment gateway is integrated.** `POST /admin/clinics/:id/subscription/payments` is the
seam that a future gateway webhook will call through `SubscriptionService.recordPayment`.
