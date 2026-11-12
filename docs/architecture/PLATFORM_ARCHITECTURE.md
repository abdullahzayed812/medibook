# Platform & clinic management: architecture

> **Purpose:** the modules, data flow and integration seams of platform and clinic management.
>
> Task 03. Builds on Task 01 (foundation) and Task 02 (identity, authorization, tenancy).
> Related: [PLATFORM_API](../api/PLATFORM_API.md) · [PLATFORM_DATABASE_SCHEMA](../database/PLATFORM_DATABASE_SCHEMA.md) ·
> [PLATFORM_AUTHORIZATION](../platform/PLATFORM_AUTHORIZATION.md)

## Modules (`apps/backend/src/modules`)

| Module                   | Responsibility                                                                                                                                                                           | Depends on                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `platform`               | Platform settings, transactional outbox (`domain_events`), private object storage interface + dev local provider, private document handling                                              | access, audit                                       |
| `subscriptions`          | Plans with immutable versions, clinic subscriptions, history, effective-status policy, entitlements (plan limits), lifecycle sweep                                                       | access, audit, platform                             |
| `clinics`                | Clinic profile, branches, operational lifecycle (suspension, access exceptions, closure), **clinic operation gate**, Super Admin clinic views                                            | access, audit, platform, subscriptions              |
| `clinic-registration`    | Registration drafts, submission, review, approval (creates the operational clinic)                                                                                                       | access, clinics, platform, subscriptions            |
| `ownership-transfer`     | Owner → recipient → Super Admin transfer workflow                                                                                                                                        | access, iam, platform                               |
| `doctor-profiles`        | Global doctor profile, specialties catalog, professional verification                                                                                                                    | access, platform                                    |
| `staff`                  | Member management, invitations, branch assignments, doctor public listing                                                                                                                | access, iam, platform, subscriptions                |
| `marketplace`            | Eligibility rules, visibility preferences, public read endpoints                                                                                                                         | clinics, doctor-profiles, subscriptions             |
| `bookings` (Task 05)     | Availability, booking lifecycle, holds/expiration, rescheduling, booking persons, delegation, guests, idempotency, settings, queue contract                                              | access, audit, clinic-setup, clinics, iam, platform |
| `clinic-setup` (Task 04) | Doctor branch assignments, service catalog and branch offerings, doctor-service eligibility, branch hours, doctor schedules, exceptions, resolved working time, time-zone/DST conversion | access, audit, platform                             |

Task 02 modules are reused, not duplicated: users, OTP, tokens and sessions (`iam`);
`AuthorizationService`, `TenantContextResolver`, `ClinicScope`, `tenantExecutor` and
`MembershipService` (`access`); `AuditLog` and `SecurityEventLog` (`audit`). The dependency
graph is acyclic. Hooks inverted through the composition root (`container.ts`):

- `ClinicOperationGate` (defined in access, implemented in clinics) is injected into
  `AuthorizationService`.
- `MembershipPolicyHooks` (capacity and outstanding-work checks) are provided by subscriptions and future modules.
- Closure hooks: `onClosing` revokes invitations and cancels transfers; `onClosed` expires the subscription.

## Four separate status dimensions

| Dimension              | Where                                                                                  | Values                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Registration status    | `clinic_registration_requests.status`                                                  | DRAFT, PENDING_REVIEW, UNDER_REVIEW, NEEDS_INFORMATION, APPROVED, REJECTED, SUSPENDED |
| Operational status     | `clinics.operational_status` (+ `clinic_suspensions`)                                  | ACTIVE, SUSPENDED, CLOSING, CLOSED                                                    |
| Subscription status    | `clinic_subscriptions.status` (+ derived effective status)                             | TRIAL, ACTIVE, PAST_DUE, SUSPENDED, EXPIRED                                           |
| Marketplace visibility | `clinics.public_visibility`, `doctors_public_visibility`, `services_public_visibility` | clinic preferences; eligibility is computed                                           |

A clinic row exists only after registration approval (`approved_at`). No single status field
combines these dimensions.

## Central enforcement: the clinic operation gate

Every clinic permission in the catalog has an **operation category** (CLINIC_INFO, READ,
CONTINUITY_OF_CARE, ADMINISTRATION, NEW_OPERATION, LIFECYCLE). When `AuthorizationService`
grants a clinic permission from memberships, it then asks the gate. The gate loads the clinic's
current operational status, open suspension, effective subscription and the selected branch's
status from MySQL, and applies one policy matrix (see [CLINIC_LIFECYCLE](../platform/CLINIC_LIFECYCLE.md)).
Every route and service that authorizes a clinic permission is therefore subject to
suspension, closure and subscription rules automatically. There is no per-route switch to forget.

## Conventions

- **Services authorize themselves.** Every service method takes the actor (`Principal`) and,
  for clinic operations, the verified `TenantContext`, then calls `authz.assert(...)` before
  doing anything. Routes only authenticate, resolve the context, validate and delegate.
- **Clinic-scoped repositories** take `ClinicScope` and use `tenantExecutor`. Super Admin
  (platform) paths take an explicit clinic id only after a platform permission check.
- **State machines.** Every status change goes through `defineStateMachine(...)`; invalid
  changes return `409 INVALID_TRANSITION`.
- **One transaction per workflow step.** Each step writes row locks, the status change,
  history rows, audit events and outbox events together.
- **Append-only history** for registrations, clinic lifecycle, suspensions, closures,
  transfers, verification, memberships and subscriptions.
- **Outbox.** `domain_events` carries integration events for notifications, billing and
  marketplace indexing. No consumer exists yet; payloads hold ids and facts only.

## Private documents

`PrivateObjectStorage` interface; `LocalPrivateStorage` (development and tests only, refused in
production by config validation and by its constructor). The approved production target,
Cloudflare R2, is still to be integrated. Uploads use a raw request body (PDF, JPEG or PNG,
≤ 10 MB) and are checked against magic bytes. Storage keys are random and never returned.
Downloads are served only after authorization, with `Content-Disposition: attachment`,
`nosniff`, `no-store` and a restrictive CSP; reviewer reads are audited.
