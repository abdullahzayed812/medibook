# MediBook documentation

> **Purpose:** the entry point to all project documentation. Every document belongs to exactly
> one category folder below. Start here, then follow the links between related documents.

## Structure

| Folder                                             | Contains                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| [architecture/](#architecture)                     | system shape, module boundaries, and the decision log (`decisions/`)    |
| [development/](#development)                       | environment setup, coding standards, testing, Git workflow, migrations  |
| [security/](#security)                             | authentication, authorization, tenant isolation, sessions, threat model |
| [platform/](#platform-and-domain-rules)            | platform and clinic business rules and workflows                        |
| [api/](#api)                                       | HTTP endpoint references                                                |
| [database/](#database)                             | schema references per migration group                                   |
| [operations/](#operations)                         | deployment, backup, monitoring (not written yet)                        |
| [tasks/](#task-reports-and-implementation-history) | one report per task: what was built, decided and verified               |
| [product/](#product-scope-and-roadmap)             | product blueprint, MVP scope, roadmap (not written yet)                 |

## Architecture

- [ARCHITECTURE.md](architecture/ARCHITECTURE.md): system shape, modules, runtime processes
- [IDENTITY_ARCHITECTURE.md](architecture/IDENTITY_ARCHITECTURE.md): accounts, roles, memberships, sessions
- [PLATFORM_ARCHITECTURE.md](architecture/PLATFORM_ARCHITECTURE.md): platform and clinic management modules
- [decisions/DECISIONS.md](architecture/decisions/DECISIONS.md): ADR log and open decisions

## Development

- [ENVIRONMENT_SETUP.md](development/ENVIRONMENT_SETUP.md): local setup, Docker, troubleshooting
- [CODING_STANDARDS.md](development/CODING_STANDARDS.md): code, API, database and security conventions
- [TESTING_GUIDELINES.md](development/TESTING_GUIDELINES.md): test layers and the integration harness
- [DATABASE_MIGRATIONS.md](development/DATABASE_MIGRATIONS.md): migration policy, rebuild, validation, recovery
- [GIT_WORKFLOW.md](development/GIT_WORKFLOW.md): branches, commits, reviews

## Security

- [AUTHENTICATION.md](security/AUTHENTICATION.md): phone OTP, tokens, MFA
- [AUTHORIZATION.md](security/AUTHORIZATION.md): permission model and role mapping
- [TENANT_ISOLATION.md](security/TENANT_ISOLATION.md): clinic data isolation
- [SESSION_MANAGEMENT.md](security/SESSION_MANAGEMENT.md): sessions and refresh tokens
- [THREAT_MODEL.md](security/THREAT_MODEL.md): threats, mitigations, residual risk

## Platform and domain rules

- [CLINIC_REGISTRATION.md](platform/CLINIC_REGISTRATION.md): application, review, approval, status dimensions
- [CLINIC_LIFECYCLE.md](platform/CLINIC_LIFECYCLE.md): operational status, suspension, closure, operating policy
- [BRANCH_MANAGEMENT.md](platform/BRANCH_MANAGEMENT.md): branches
- [CLINIC_MEMBERSHIPS.md](platform/CLINIC_MEMBERSHIPS.md): staff, invitations, roles
- [OWNERSHIP_TRANSFER.md](platform/OWNERSHIP_TRANSFER.md): transferring a clinic
- [DOCTOR_PROFILES.md](platform/DOCTOR_PROFILES.md): doctor profiles, specialty catalog, verification
- [SUBSCRIPTION_MANAGEMENT.md](platform/SUBSCRIPTION_MANAGEMENT.md): plans and subscriptions
- [MARKETPLACE_ELIGIBILITY.md](platform/MARKETPLACE_ELIGIBILITY.md): public Marketplace rules
- [PLATFORM_AUTHORIZATION.md](platform/PLATFORM_AUTHORIZATION.md): platform permissions and how each requirement is enforced
- [DOCTOR_ASSIGNMENTS.md](platform/DOCTOR_ASSIGNMENTS.md): doctors at branches, eligibility, effectiveness (Task 04)
- [SERVICE_CATALOG.md](platform/SERVICE_CATALOG.md): clinic services, branch offerings, doctor-service eligibility (Task 04)
- [SCHEDULES.md](platform/SCHEDULES.md): branch hours, doctor schedules, exceptions, time zones and DST (Task 04)
- [BOOKINGS.md](platform/BOOKINGS.md): booking engine — availability, lifecycle, holds, rescheduling, conflicts, concurrency, queue boundary (Task 05)
- [BOOKING_PERSONS.md](platform/BOOKING_PERSONS.md): booking persons, canonical booking identity & links, ownership & claim codes, phone changes, support cases, legacy identity audit, delegation, guests (Task 05/05.1/05.2)

## API

- [PLATFORM_API.md](api/PLATFORM_API.md): platform and clinic management endpoints
- [CLINIC_SETUP_API.md](api/CLINIC_SETUP_API.md): doctors, services, branch hours and schedules (Task 04)
- [BOOKINGS_API.md](api/BOOKINGS_API.md): availability, patient, guest and clinic booking endpoints (Task 05)
- Identity endpoints (auth, sessions, MFA, `/me`) are currently documented in
  [AUTHENTICATION.md](security/AUTHENTICATION.md) and
  [SESSION_MANAGEMENT.md](security/SESSION_MANAGEMENT.md).

## Database

- [IDENTITY_SCHEMA.md](database/IDENTITY_SCHEMA.md): Task 02 migrations `140001`–`140020`
- [PLATFORM_DATABASE_SCHEMA.md](database/PLATFORM_DATABASE_SCHEMA.md): Task 03 migrations `150001`–`150025`
- [CLINIC_SETUP_SCHEMA.md](database/CLINIC_SETUP_SCHEMA.md): Task 04 migrations `160001`–`160007`
- [BOOKINGS_SCHEMA.md](database/BOOKINGS_SCHEMA.md): Task 05 migrations `170001`–`170010`
- Migration policy and procedures: [DATABASE_MIGRATIONS.md](development/DATABASE_MIGRATIONS.md)

## Operations

Not written yet. Deployment, backup and recovery, and monitoring documents belong in
`operations/` once deployment is designed. The binding backup requirements for migrations are
already in [DATABASE_MIGRATIONS.md](development/DATABASE_MIGRATIONS.md#9-backup-and-recovery-requirements).

## Task reports and implementation history

- [tasks/README.md](tasks/README.md): index of all task reports, with status

## Product scope and roadmap

Not written yet. The product blueprint and MVP scope belong in `product/`. Until then, the
project summary is in the [root README](../README.md).

## Conventions

- **Placement:** every new document goes into the matching category folder. Never add files
  directly under `docs/` (only this index lives there).
- **Names:** descriptive `UPPER_SNAKE_CASE.md` (for example `CLINIC_LIFECYCLE.md`). Task
  reports use `TASK_<NN>_REPORT.md` (corrections: `TASK_<NN>_<N>_REPORT.md`).
- **Format:** Markdown with **relative** links (`../security/AUTHORIZATION.md`), including
  anchors where useful.
- **Scope:** one clear responsibility per document. Split a document that starts mixing
  unrelated domains. Link to the canonical document instead of duplicating its content.
- **Purpose line:** every major document starts with a `> **Purpose:** …` statement under its
  title.
- **Cross-links:** link related architecture, API, schema, security and business-rule documents
  to each other.
- **History:** decisions are never deleted. Mark superseded or obsolete content as such and keep
  the history. ADR numbers are permanent.
- **Moves:** when moving or renaming a document, update every reference in the repository
  (Markdown links, README files, code comments) in the same change, and check for broken links.
