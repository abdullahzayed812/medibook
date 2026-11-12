# Marketplace eligibility

> **Purpose:** the rules that decide whether a clinic and its doctors appear in the public Marketplace.

`evaluateMarketplaceEligibility` (pure, unit-tested) and `MarketplaceService.eligibility(clinicId)`
are the reusable domain functions. A clinic is **eligible** only when all of these hold:

| Condition                                                                    | Reason code when unmet      |
| ---------------------------------------------------------------------------- | --------------------------- |
| Registration approved (`approved_at`)                                        | `REGISTRATION_NOT_APPROVED` |
| Operational status ACTIVE                                                    | `CLINIC_NOT_ACTIVE`         |
| No open suspension                                                           | `CLINIC_SUSPENDED`          |
| Subscription in good standing (effective TRIAL, ACTIVE or in-grace PAST_DUE) | `SUBSCRIPTION_NOT_ELIGIBLE` |
| Plan feature `marketplace_listing`                                           | `PLAN_EXCLUDES_MARKETPLACE` |
| Clinic enabled `publicVisibility` (default **off**)                          | `VISIBILITY_DISABLED`       |

**Clinic controls** (`PATCH /clinic/marketplace`, `clinic.marketplace.manage`, audited):
`publicVisibility`, `doctorsPublicVisibility`, `servicesPublicVisibility` (stored for the future
services module). Hiding never affects internal operations. Owners see the eligibility reasons in
`GET /clinic/marketplace`.

## Public endpoints (no authentication, read-only)

| Endpoint                           | Returns                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /public/clinics?limit&cursor` | eligible clinics: id, name, type, description, website, city, region, country                                    |
| `GET /public/clinics/:id`          | the above + active branches (name, address line, city, region, country, coordinates, time zone) + public doctors |
| `GET /public/doctors/:id`          | public doctor profile + the eligible clinics listing them                                                        |

Non-eligible resources return 404. Public projections are explicit allow-lists. They never
expose legal names, registration or tax numbers, owners, staff, contact details, statuses,
license data or documents (tested). Search and pages are out of scope.
