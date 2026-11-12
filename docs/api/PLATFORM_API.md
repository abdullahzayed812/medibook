# Platform & clinic management API (`/api/v1`)

> **Purpose:** endpoint reference (method, path, permission, purpose) for platform and clinic management.

Conventions (Task 02): `{ data }` responses; lists use `{ data, page: { limit, nextCursor } }`
(keyset pagination, `limit` ≤ 100); errors use `{ error: { code, message, requestId, details? } }`.
Every input is validated with zod. **Clinic** endpoints need `Authorization` plus a verified
clinic context (`X-Clinic-Id`, optional `X-Branch-Id`). **Admin** endpoints need a platform
permission and therefore an MFA-verified session. Authorization runs inside services; the
permissions are listed here for reference. "party" means the resource owner (ownership check).

## Registration

| Method & path                                                             | Permission                          | Purpose                         |
| ------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| POST `/registrations`                                                     | authenticated                       | create draft (201)              |
| GET `/registrations`                                                      | authenticated                       | own requests                    |
| GET `/registrations/:id`                                                  | applicant                           | request + documents + history   |
| PATCH `/registrations/:id`                                                | applicant (DRAFT/NEEDS_INFORMATION) | edit                            |
| POST `/registrations/:id/submit`                                          | applicant                           | submit                          |
| POST `/registrations/:id/documents?type&filename`                         | applicant                           | upload (raw body: PDF/JPEG/PNG) |
| DELETE `/registrations/:id/documents/:documentId`                         | applicant                           | soft remove                     |
| GET `/registrations/:id/documents/:documentId/content`                    | applicant                           | download                        |
| GET `/admin/registrations?status&sort&limit&cursor`                       | platform.registrations.review       | list (no drafts)                |
| GET `/admin/registrations/:id`                                            | platform.registrations.review       | review details                  |
| GET `/admin/registrations/:id/documents/:documentId/content`              | platform.registrations.review       | download (audited)              |
| POST `/admin/registrations/:id/start-review`                              | platform.registrations.review       | → UNDER_REVIEW                  |
| POST `/admin/registrations/:id/request-information` `{reason}`            | platform.registrations.review       | → NEEDS_INFORMATION             |
| POST `/admin/registrations/:id/approve` `{planId, billingCycle, reason?}` | platform.registrations.review       | → APPROVED; creates clinic      |
| POST `/admin/registrations/:id/reject` `{reason}`                         | platform.registrations.review       | → REJECTED                      |
| POST `/admin/registrations/:id/suspend` `{reason}` / `resume` `{reason}`  | platform.registrations.review       | freeze / resume review          |

## Clinic, branches, lifecycle

| Method & path                                                                        | Permission                     | Purpose                                   |
| ------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------- |
| GET `/clinic`                                                                        | clinic.profile.view            | profile + operating state                 |
| PATCH `/clinic`                                                                      | clinic.profile.manage          | edit profile (not name or legal identity) |
| GET `/clinic/branches`, GET `/clinic/branches/:branchId`                             | clinic.branches.view           | covered branches                          |
| POST `/clinic/branches`, PATCH `/clinic/branches/:branchId`                          | clinic.branches.manage         | create / update                           |
| POST `/clinic/branches/:branchId/activate`, `…/deactivate`                           | clinic.branches.manage         | status                                    |
| GET `/clinic/closure-requests`, GET `/clinic/closure-requests/:id`                   | clinic.lifecycle.manage        | requests + actions                        |
| POST `/clinic/closure-requests` `{reason, requestedEffectiveDate?}`                  | clinic.lifecycle.manage        | request closure                           |
| POST `/clinic/closure-requests/:id/cancel`                                           | clinic.lifecycle.manage        | cancel before review                      |
| POST `/clinic/closure-requests/:id/actions/:actionId/resolve` `{note}`               | clinic.lifecycle.manage        | resolve action                            |
| GET `/admin/clinics?operationalStatus`, GET `/admin/clinics/:clinicId`               | platform.clinics.view          | list / detail                             |
| POST `/admin/clinics/:clinicId/suspend` `{scope, reason, expectedEndAt?}`            | platform.clinics.manage        | suspend                                   |
| POST `/admin/clinics/:clinicId/reinstate` `{reason}`                                 | platform.clinics.manage        | reinstate                                 |
| GET `/admin/clinics/:clinicId/suspensions`                                           | platform.clinics.view          | suspension history                        |
| GET, POST `/admin/clinics/:clinicId/access-exceptions` `{userId, reason, expiresAt}` | platform.clinics.view / manage | continuity-of-care exceptions             |
| POST `/admin/clinics/:clinicId/access-exceptions/:exceptionId/revoke`                | platform.clinics.manage        | revoke                                    |
| GET `/admin/closure-requests?status`, GET `/admin/closure-requests/:id`              | platform.clinics.view          | review                                    |
| POST `/admin/closure-requests/:id/approve` / `reject` / `complete` `{reason}`        | platform.clinics.manage        | decide / complete                         |
| POST `/admin/closure-requests/:id/actions/:actionId/resolve` / `waive` `{note}`      | platform.clinics.manage        | actions                                   |

## Ownership transfer

| Method & path                                                                 | Permission                             | Purpose                   |
| ----------------------------------------------------------------------------- | -------------------------------------- | ------------------------- |
| GET, POST `/clinic/ownership-transfers` `{phone, reason?}`                    | clinic.lifecycle.manage + CLINIC_OWNER | list / initiate           |
| POST `/clinic/ownership-transfers/:id/cancel`                                 | clinic.lifecycle.manage                | cancel                    |
| GET `/ownership-transfers/incoming`                                           | authenticated                          | transfers addressed to me |
| GET `/ownership-transfers/:id`                                                | party                                  | details + documents       |
| POST `/ownership-transfers/:id/accept` / `decline`                            | recipient                              | respond                   |
| POST `/ownership-transfers/:id/documents?type&filename`                       | party                                  | upload                    |
| GET `/ownership-transfers/:id/documents/:documentId/content`                  | party                                  | download                  |
| GET `/admin/ownership-transfers?status`, GET `/admin/ownership-transfers/:id` | platform.ownership.review              | review (+history)         |
| GET `/admin/ownership-transfers/:id/documents/:documentId/content`            | platform.ownership.review              | download (audited)        |
| POST `/admin/ownership-transfers/:id/identity` `{result, note}`               | platform.ownership.review (non-party)  | identity verification     |
| POST `/admin/ownership-transfers/:id/approve` / `reject` `{reason}`           | platform.ownership.review (non-party)  | decide                    |

## Doctor profiles

| Method & path                                                                                            | Permission                         | Purpose                      |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| GET `/specialties`                                                                                       | public                             | active specialties           |
| POST, GET, PATCH `/me/doctor-profile`                                                                    | authenticated (own)                | create / view / edit         |
| POST `/me/doctor-profile/documents?type&filename`                                                        | own                                | upload verification document |
| GET `/me/doctor-profile/documents/:documentId/content`                                                   | own                                | download                     |
| POST `/me/doctor-profile/verification`                                                                   | own                                | submit for review            |
| GET `/admin/doctor-profiles?status`, GET `/admin/doctor-profiles/:id`                                    | platform.doctors.verify            | review                       |
| GET `/admin/doctor-profiles/:id/documents/:documentId/content`                                           | platform.doctors.verify            | download (audited)           |
| POST `/admin/doctor-profiles/:id/verification` `{decision: APPROVE\|REJECT\|SUSPEND\|REINSTATE, reason}` | platform.doctors.verify (not self) | decide                       |
| PUT `/admin/specialties/:code` `{name, active?}`                                                         | platform.specialties.manage        | create / rename / deactivate |

## Staff and invitations

| Method & path                                                           | Permission                                  | Purpose                          |
| ----------------------------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| GET `/clinic/members?status&limit&cursor`                               | clinic.memberships.view                     | members (masked phones)          |
| PATCH `/clinic/members/:membershipId/status` `{status, reason}`         | clinic.memberships.manage + assignable role | lifecycle                        |
| PUT `/clinic/members/:membershipId/branches` `{branchScope, branchIds}` | clinic.memberships.manage + assignable role | assignments                      |
| PATCH `/clinic/members/:membershipId/public-listing` `{publicListing}`  | clinic.doctors.manage                       | doctor listing                   |
| GET `/clinic/invitations?status`                                        | clinic.memberships.view                     | invitations                      |
| POST `/clinic/invitations` `{phone, role, branchScope, branchIds}`      | clinic.memberships.manage + assignable role | invite (token returned once)     |
| POST `/clinic/invitations/:id/revoke`                                   | clinic.memberships.manage + assignable role | revoke                           |
| GET `/me/invitations`                                                   | authenticated                               | pending invitations for my phone |
| POST `/invitations/accept` / `decline` `{token}`                        | invited phone                               | respond                          |

## Subscriptions, plans, settings

| Method & path                                                                       | Permission                    | Purpose                         |
| ----------------------------------------------------------------------------------- | ----------------------------- | ------------------------------- |
| GET `/plans`                                                                        | public                        | active plans with current terms |
| GET `/clinic/subscription`, GET `/clinic/subscription/history`                      | clinic.subscription.view      | details / history               |
| POST `/admin/plans`, GET `/admin/plans/:planId`                                     | platform.plans.manage         | create / view versions          |
| POST `/admin/plans/:planId/versions`                                                | platform.plans.manage         | new immutable version           |
| POST `/admin/plans/:planId/activate` / `deactivate`                                 | platform.plans.manage         | status                          |
| GET `/admin/clinics/:clinicId/subscription`, `…/history`                            | platform.subscriptions.manage | view                            |
| POST `/admin/clinics/:clinicId/subscription/payments` `{billingCycle?, reference?}` | platform.subscriptions.manage | record payment (billing seam)   |
| POST `…/subscription/change-plan` `{planId, reason}`                                | platform.subscriptions.manage | change plan                     |
| POST `…/subscription/suspend` / `reactivate` / `expire` `{reason}`                  | platform.subscriptions.manage | status                          |
| PUT `…/subscription/grace-period` `{days\|null, reason}`                            | platform.subscriptions.manage | per-clinic grace                |
| GET, PATCH `/admin/settings`                                                        | platform.settings.manage      | platform settings (audited)     |

## Marketplace

| Method & path                                                       | Permission                | Purpose                   |
| ------------------------------------------------------------------- | ------------------------- | ------------------------- |
| GET, PATCH `/clinic/marketplace`                                    | clinic.marketplace.manage | visibility + eligibility  |
| GET `/public/clinics`, `/public/clinics/:id`, `/public/doctors/:id` | public                    | eligible public data only |
