# Architecture

> **Purpose:** the overall system shape, module boundaries, runtime processes and cross-cutting technical rules.

## 1. System shape

MediBook is a **modular monolith**: one deployable backend codebase, split internally into
modules with explicit boundaries, backed by **one shared MySQL 8 database**. It is deliberately
**not** a set of microservices (see [DECISIONS.md](decisions/DECISIONS.md), ADR-001).

```
            ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 clients    │ admin-web    │ │ clinic-web   │ │ patient-web  │ │ mobile apps  │
            └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                   └────────────────┴───── HTTPS / Socket.IO (future) ─┘
                                          │
            ┌─────────────────────────────▼─────────────────────────────┐
 backend    │ API process (src/server.ts)      Worker process (src/worker.ts)
 (one       │  Express app ── modules/*        BullMQ workers ── jobs/registry
 codebase,  │        │                               │
 two entry  │        └──────── infrastructure/* ─────┘   (database, redis, queue)
 points)    └───────────────┬──────────────────────────┬────────────────┘
                            │                          │
                     ┌──────▼──────┐            ┌──────▼──────┐
                     │  MySQL 8    │            │  Redis 7    │
                     │ source of   │            │ queues,     │
                     │ truth       │            │ cache (fut.)│
                     └─────────────┘            └─────────────┘
```

The API and worker are **two processes built from the same codebase**. They share modules and
infrastructure code but scale and fail independently: a slow job never blocks HTTP requests.

## 2. Backend layout (`apps/backend`)

```
src/
  server.ts            API entry: config → logger → infrastructure → app → listen → shutdown
  worker.ts            Worker entry: config → logger → infrastructure → BullMQ workers → shutdown
  app.ts               createApp(deps): builds the Express app; opens no ports/connections
  config/              Environment schema + validation (fail fast), .env loader
  shared/              Cross-cutting, business-agnostic code
    errors/            AppError hierarchy (expected/operational errors)
    http/              Error envelope type, middleware (request logger + correlation ID,
                       validation, not-found, centralized error handler)
    lifecycle/         Graceful shutdown
    logger/            pino structured logger factory + redaction list
  infrastructure/      Adapters to external systems; no business rules
    database/          MySQL pool, parameterized query + transaction helpers, migrations
    redis/             ioredis client factory
    queue/             BullMQ queue/worker factories and defaults
  container.ts         Composition root for /api/v1 (repositories → services → routers)
  modules/             Business modules
    health/            index.ts (public API) · *.routes.ts · *.controller.ts · *.service.ts
    audit/             security_events + audit_events (Task 02)
    iam/               identity, OTP, tokens, sessions, 2FA, account status (Task 02)
    access/            permission catalog, authorization, memberships, tenant context (Task 02)
    patient-profiles/  tenant-scoped repository reference (Task 02)
    platform-admin/    SUPER_ADMIN endpoints (Task 02)
    platform/ subscriptions/ clinics/ clinic-registration/ ownership-transfer/
    doctor-profiles/ staff/ marketplace/   Task 03 (see docs/architecture/PLATFORM_ARCHITECTURE.md)
  tools/               Operator CLIs: secrets:generate, role:grant / role:revoke (Task 02)
  jobs/registry.ts     Job definitions run by the worker (empty in Task 01)
  test-support/        Test-only helpers (excluded from the build)
migrations/            Versioned SQL migration files
tests/integration/     Tests against real MySQL/Redis
```

### Dependency direction

```
server.ts / worker.ts  →  app.ts  →  modules/*  →  shared/*
                                         │
                                         └──→ infrastructure/*  →  shared/*
```

- `shared/` and `infrastructure/` **never** import from `modules/`.
- `infrastructure/` contains no business rules (no tenant logic, no medical rules).
- Entry points are the only place where concrete infrastructure is created and wired
  (composition root). Everything else receives its dependencies as constructor/function
  arguments, which keeps code testable without mocking frameworks.

## 3. Module structure and boundaries

Each business module lives in `src/modules/<name>/`:

| File                   | Responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| `index.ts`             | **Public API** of the module. The only file other modules/app code may import. |
| `<name>.routes.ts`     | Express router: paths, middleware (e.g. `validate(...)`), controller binding.  |
| `<name>.controller.ts` | HTTP adapter only: read validated input, call the service, write the response. |
| `<name>.service.ts`    | Business logic / use cases. Knows nothing about Express.                       |
| `<name>.repository.ts` | (future) Raw SQL for the module's own tables, via the `SqlExecutor` interface. |
| `<name>.schemas.ts`    | (future) zod request schemas.                                                  |
| `<name>.jobs.ts`       | (future) BullMQ job definitions, registered in `jobs/registry.ts`.             |

Rules:

1. **No business logic in controllers.** Controllers translate HTTP ↔ service calls.
2. **No deep imports across modules.** `modules/a` may use `modules/b` only through
   `modules/b/index.ts`.
3. **Tables are owned by one module.** Other modules read/write them only through the owning
   module's public API, never with their own SQL against those tables. Cross-module joins for
   reporting are an explicit, documented exception (decided case by case).
4. **Tenant isolation (future modules).** Every tenant-owned table carries a tenant key and every
   query on it filters by tenant. This is enforced in repositories, never left to callers.
   Mechanism: see [TENANT_ISOLATION.md](../security/TENANT_ISOLATION.md) (ADR-019).

## 4. Request lifecycle

1. `requestLogger` (pino-http) resolves the **correlation ID**: a well-formed incoming
   `X-Request-Id` is reused, otherwise a UUID v4 is generated. It is echoed in the response
   header, bound to every log line as `req.id`, and included in error bodies as `requestId`.
2. `express.json({ limit })` parses JSON bodies (parse/size/charset errors become 400/413/415).
3. Router → `validate({ params, query, body })` (zod) → controller → service.
4. Errors thrown anywhere (sync or async; Express 5 forwards rejected promises) reach the
   **centralized error handler**, which returns:

   ```json
   { "error": { "code": "VALIDATION_ERROR", "message": "…", "requestId": "…", "details": [] } }
   ```

   `AppError` subclasses map to their status code; anything else becomes a generic 500 and is
   logged with its stack, never sent to the client.

## 5. Health endpoints

| Endpoint            | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /health`       | **Liveness.** Process is up. Never touches dependencies. Used by the Docker healthcheck.           |
| `GET /health/ready` | **Readiness.** MySQL and Redis reachable (per-check timeout) and not shutting down; 503 otherwise. |

## 6. Data and messaging

- **MySQL is the source of truth** for all important business state. Raw SQL only, through
  `Database` (`query`, `execute`, `transaction`), always parameterized. See
  [CODING_STANDARDS.md § Database](../development/CODING_STANDARDS.md#database).
- **Schema changes** go through forward-only, checksummed migrations
  (`src/infrastructure/database/migrations`).
- **Redis + BullMQ** carry background work. Queues are not a system of record: a job must be
  re-creatable from MySQL state, and processors must be idempotent (at-least-once delivery).
  When a business write must also enqueue a job, the reliable pattern (e.g. an outbox table
  written in the same transaction) is decided with the first such feature (OD-04).

## 7. Process lifecycle

Both entry points use `createGracefulShutdown`, triggered by `SIGTERM`/`SIGINT`, unhandled
rejections and uncaught exceptions. Resources close **sequentially** within
`SHUTDOWN_TIMEOUT_MS`, after which the process is forced to exit with code 1:

- API: mark not-ready (readiness → 503) and stop accepting connections → Redis → MySQL pool.
- Worker: BullMQ workers (stop fetching, finish active jobs) → Redis → MySQL pool.

In Docker, `init: true` (tini) makes sure signals reach the Node process.

## 8. Frontend and shared packages

- `packages/*` are TypeScript libraries compiled with `tsc` to `dist/` (ESM + `.d.ts`). They are
  empty skeletons until a task needs them. Intended contents: `shared-types` (API contracts),
  `validation` (shared zod schemas), `api-client` (typed HTTP client), `auth` (shared auth
  primitives), `design-tokens`, `shared-utils`.
- Web apps (React + TS) and mobile apps (React Native CLI) are placeholder workspaces; their
  scaffolding and toolchain decisions are recorded as open decisions OD-01/OD-02.

## 9. Future integrations (not implemented)

- **Socket.IO** for real-time updates (will need the Redis adapter once the API runs more than
  one instance).
- **Cloudflare R2** private object storage for files (signed, short-lived URLs; no public buckets).
