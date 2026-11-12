# MediBook

Multi-tenant **Clinic Management SaaS** and **Medical Marketplace**, built as an npm-workspaces
monorepo around a **modular monolith** backend (Node.js 20 · TypeScript · Express · MySQL 8 with
raw SQL · Redis · BullMQ).

> **Status — Task 03 (platform & clinic management).** Identity, authorization and tenancy
> (Task 02) plus clinic registration, lifecycle, branches, staff, ownership transfer, doctor
> profiles, subscriptions and marketplace eligibility are implemented. No scheduling, booking or
> medical workflows exist yet. Never use real patient data in any environment other than production.

## Repository layout

```
apps/
  backend/          Express API + BullMQ worker (modular monolith)        ← implemented skeleton
  admin-web/        Platform admin web app (React + TS)                   ← placeholder
  clinic-web/       Clinic web app (React + TS)                           ← placeholder
  patient-web/      Patient web app (React + TS)                          ← placeholder
  patient-mobile/   Patient mobile app (React Native CLI)                 ← placeholder
  staff-mobile/     Staff mobile app (React Native CLI)                   ← placeholder
packages/
  shared-types/  api-client/  validation/  auth/  design-tokens/  shared-utils/   ← buildable skeletons
infrastructure/
  docker/           Dockerfiles
  mysql/init/       MySQL first-boot scripts (creates the integration-test database)
docs/
  architecture/  development/  decisions/
docker-compose.yml  Development stack: backend, MySQL 8.4, Redis 7.4 (+ optional worker)
```

## Quick start

Requirements: Node.js 20.19+ (see `.nvmrc`), npm 10+, Docker with Compose v2.

```bash
npm install                      # install all workspaces
cp .env.example .env             # then fill in every empty value (see the file's comments)
docker compose up -d --build     # backend + MySQL + Redis
curl http://127.0.0.1:3000/health/ready
docker compose exec backend npm run migrate
```

Full instructions, including running the backend on the host: [ENVIRONMENT_SETUP.md](docs/development/ENVIRONMENT_SETUP.md).

## Root scripts

| Script                                                                                                                                              | Purpose                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `npm run dev` / `npm run dev:worker`                                                                                                                | Run the API / worker on the host with hot reload (tsx watch) |
| `npm run build`                                                                                                                                     | Compile every workspace (`tsc`)                              |
| `npm run typecheck`                                                                                                                                 | Type-check every workspace                                   |
| `npm run lint` / `lint:fix`                                                                                                                         | ESLint (type-aware, zero warnings allowed)                   |
| `npm run format` / `format:check`                                                                                                                   | Prettier                                                     |
| `npm test`                                                                                                                                          | Unit tests (no Docker needed)                                |
| `npm run test:integration`                                                                                                                          | Integration tests against real MySQL + Redis                 |
| `npm run test:auth` / `test:authorization` / `test:tenant` / `test:security` / `test:api` / `test:platform` / `test:clinic-setup` / `test:bookings` | Individual integration suites                                |
| `npm run secrets:generate`                                                                                                                          | Generate auth secrets and an Ed25519 signing key for `.env`  |
| `npm run role:grant -- <phone> SUPER_ADMIN` / `role:revoke`                                                                                         | Grant or revoke a global role (audited)                      |
| `npm run migrate` / `migrate:status` / `migrate:create`                                                                                             | Database migrations                                          |
| `npm run docker:up` / `docker:down` / `docker:config`                                                                                               | Docker Compose helpers                                       |
| `npm run validate`                                                                                                                                  | format check + lint + typecheck + unit tests + build         |

## Documentation

**Start at the [documentation index](docs/README.md)**, which lists every document by category.
Frequently used:

- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Environment setup](docs/development/ENVIRONMENT_SETUP.md)
- [Coding standards](docs/development/CODING_STANDARDS.md) (includes database standards)
- [Database migrations](docs/development/DATABASE_MIGRATIONS.md) (policy, rebuild, recovery)
- [Testing guidelines](docs/development/TESTING_GUIDELINES.md)
- [Git workflow](docs/development/GIT_WORKFLOW.md)
- [Architecture decisions](docs/architecture/decisions/DECISIONS.md)
- Identity: [Identity architecture](docs/architecture/IDENTITY_ARCHITECTURE.md) ·
  [Authentication](docs/security/AUTHENTICATION.md) ·
  [Authorization](docs/security/AUTHORIZATION.md) ·
  [Tenant isolation](docs/security/TENANT_ISOLATION.md) ·
  [Identity schema](docs/database/IDENTITY_SCHEMA.md) ·
  [Session management](docs/security/SESSION_MANAGEMENT.md) ·
  [Threat model](docs/security/THREAT_MODEL.md)
- Platform (Task 03): [Architecture](docs/architecture/PLATFORM_ARCHITECTURE.md) · [API](docs/api/PLATFORM_API.md) ·
  [Schema](docs/database/PLATFORM_DATABASE_SCHEMA.md) · [Authorization](docs/platform/PLATFORM_AUTHORIZATION.md) ·
  [Registration](docs/platform/CLINIC_REGISTRATION.md) · [Lifecycle](docs/platform/CLINIC_LIFECYCLE.md) ·
  [Branches](docs/platform/BRANCH_MANAGEMENT.md) · [Doctor profiles](docs/platform/DOCTOR_PROFILES.md) ·
  [Memberships](docs/platform/CLINIC_MEMBERSHIPS.md) · [Ownership transfer](docs/platform/OWNERSHIP_TRANSFER.md) ·
  [Subscriptions](docs/platform/SUBSCRIPTION_MANAGEMENT.md) · [Marketplace](docs/platform/MARKETPLACE_ELIGIBILITY.md)
- Clinic setup (Task 04): [Doctor assignments](docs/platform/DOCTOR_ASSIGNMENTS.md) ·
  [Services](docs/platform/SERVICE_CATALOG.md) · [Schedules & time zones](docs/platform/SCHEDULES.md) ·
  [API](docs/api/CLINIC_SETUP_API.md) · [Schema](docs/database/CLINIC_SETUP_SCHEMA.md)
- Bookings (Task 05): [Booking engine](docs/platform/BOOKINGS.md) · [Persons & guests](docs/platform/BOOKING_PERSONS.md) ·
  [API](docs/api/BOOKINGS_API.md) · [Schema](docs/database/BOOKINGS_SCHEMA.md)
- [Task reports](docs/tasks/README.md)
