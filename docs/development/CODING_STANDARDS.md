# Coding standards

> **Purpose:** the coding, API, database and security conventions every workspace follows.

These standards apply to every workspace. Tooling enforces most of them: `npm run lint`,
`npm run typecheck`, `npm run format:check`.

## TypeScript

- `strict` mode plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` (see `tsconfig.base.json`). Do not weaken these per workspace.
- **No `any`.** `@typescript-eslint/no-explicit-any` is an error. Use `unknown` and narrow.
  If `any` is truly unavoidable (e.g. a broken third-party type), use a single-line
  `eslint-disable-next-line` **with a justification comment**.
- Type assertions (`as`) only at trust boundaries (DB rows, parsed JSON in tests), with a comment
  when not obvious. Prefer zod parsing for untrusted input.
- ESM everywhere (`"type": "module"`); relative imports use the `.js` extension.
- Use `import type` for type-only imports (enforced).
- Prefer plain functions and small classes with constructor-injected dependencies. No DI
  container, no decorators, no service locators.
- Don't add abstractions "for later". Add an interface when there are two implementations
  or a test needs a seam.

## Formatting and naming

- Prettier decides formatting (single quotes, semicolons, trailing commas, 100 columns).
- Files: `kebab-case.ts`; module files: `<module>.<role>.ts` (e.g. `clinics.service.ts`).
- Types/classes `PascalCase`; functions/variables `camelCase`; constants `UPPER_SNAKE_CASE`.
- SQL identifiers: `snake_case`; tables plural (`clinics`, `clinic_staff`).

## Backend layering

- **Controllers**: HTTP only. Read validated input, call one service method, write the response.
  No SQL, no business rules, no `try/catch` for error mapping (throw and let the handler map it).
- **Services**: business logic. No Express types (`Request`, `Response`).
- **Repositories** (future): raw SQL for the module's own tables. Accept a `SqlExecutor` so
  they work both inside and outside a transaction.
- **Infrastructure**: no business rules.
- Modules talk to each other only through `modules/<name>/index.ts`.

## Identity, authorization and tenancy

- Protect every endpoint with `authenticate` and, where needed, `clinicContext` + `requirePermission`.
  Never check roles directly. See [AUTHORIZATION.md](../security/AUTHORIZATION.md).
- Never read a clinic id from the body, query or path to establish context. Use `req.tenant`.
- Repositories for clinic-scoped tables take a `ClinicScope` and use `tenantExecutor`. See the
  checklist in [TENANT_ISOLATION.md](../security/TENANT_ISOLATION.md).
- Cross-tenant or foreign-owner resources must return **404**, the same as missing ones.
- Record security-relevant outcomes in `security_events` and privileged changes in `audit_events`,
  in the same transaction as the change. Never put OTPs, tokens, secrets or medical data in them.

## Errors

- Throw `AppError` subclasses (`NotFoundError`, `ConflictError`, `ValidationError`, …) for
  expected failures. Messages are client-facing: no SQL, stack traces, IDs of other tenants or
  personal data.
- Unexpected errors: just let them propagate. The central handler logs them and returns a 500.
- Never swallow errors silently. If you catch, either handle completely or rethrow.

## Validation

- Every route that accepts input uses `validate({ params, query, body })` with zod schemas.
- Schemas should be strict about types and lengths. zod's default object parsing strips unknown
  keys, so controllers never see unexpected fields.
- Shared request/response schemas move to `packages/validation` once a client needs them.

## Logging

- Use the structured logger (`req.log` in handlers, injected `Logger` elsewhere). **No
  `console.*`** (lint error).
- Log objects, not concatenated strings: `log.info({ clinicId }, 'Clinic created')`.
- **Never log** passwords, tokens, request/response bodies, or personal/medical data. Extend
  `REDACTED_PATHS` in `shared/logger/logger.ts` when you add sensitive fields.
- Don't put personal data in URLs (paths or query strings): URLs are logged.

## Configuration

- All configuration comes from environment variables declared in `config/env.ts`. Never read
  `process.env` elsewhere.
- No secrets in code, Compose files, Dockerfiles, tests or docs. `.env.example` files contain
  empty placeholders only.

## Database

### Access

- **Raw SQL only.** No ORM, no query builder.
- **Always parameterize.** Values go through `?` placeholders and the `params` array.
  **Never** build SQL by concatenating or interpolating values.
  ```ts
  // ✅
  await db.query<ClinicRow>('SELECT id, name FROM clinics WHERE id = ? AND tenant_id = ?', [
    id,
    tenantId,
  ]);
  // ❌ SQL injection
  await db.query(`SELECT * FROM clinics WHERE name = '${name}'`);
  ```
- Dynamic **identifiers** (sort columns, directions) must come from a hard-coded allow-list in
  code, never from user input directly.
- `IN (...)` lists: generate one `?` per element (`ids.map(() => '?').join(', ')`) and reject
  empty lists before querying.
- Application connections have `multipleStatements` disabled. Only the migration runner enables it.
- Use `db.query` for row-returning statements and `db.execute` for writes (`affectedRows`,
  `insertId`). Both use server-side prepared statements. Bind numeric `LIMIT`/`OFFSET` values as
  numbers.
- Select explicit columns; avoid `SELECT *` in application code.
- Define an interface for each row shape and map rows to domain objects in the repository.
- `BIGINT` and `DECIMAL` values come back as **strings** (lossless). Convert deliberately.
  Never store money in floating point; use `DECIMAL` or integer minor units.
- All timestamps are stored and handled in **UTC** (`timezone: 'Z'`, server `default-time-zone`).

### Transactions

- Use `db.transaction(async (tx) => { … })`. It commits on success, rolls back on throw, and
  always returns the connection to the pool.
- Inside the callback use **only** `tx`, never `db`. Queries on `db` run on another connection
  and are outside the transaction.
- Keep transactions short. Never await network calls (HTTP, Redis, R2, email) inside one.
- Nested transactions are not supported (the `tx` object has no `transaction` method).
- Use `SELECT … FOR UPDATE` deliberately for read-modify-write races (e.g. slot booking) and
  always lock rows in a consistent order to avoid deadlocks.

### Schema and migrations

- Every schema change is a migration file in `apps/backend/migrations`:
  `npm run migrate:create -- <snake_case_name>`.
- **Forward-only.** The runner verifies checksums and history order. When a migration may be
  amended (only before the first Production release, and only if every database that applied
  it is disposable) and when it is immutable (shared environments, and always after the first
  Production release) is defined in [DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md).
- **One logical change per migration.** MySQL DDL auto-commits, so a multi-statement migration
  that fails halfway leaves a partial change that must be repaired by hand.
- Prefer backward-compatible (expand → migrate → contract) changes so a deploy can roll back
  application code without rolling back the schema.
- Table conventions:
  - `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
  - Primary key on every table; foreign keys with an explicit `ON DELETE` behaviour.
  - `created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` and
    `updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`.
  - Index every foreign key and every column used in frequent `WHERE`/`ORDER BY` clauses.
  - Tenant-owned tables (future): tenant key column, included first in relevant composite
    indexes and unique constraints.
- Never put real patient data in migrations, seeds, fixtures or tests.

## Background jobs

- Job data holds identifiers, not copies of business records. Re-read state from MySQL.
- Processors must be **idempotent**: jobs may run more than once.
- Register job definitions in `src/jobs/registry.ts`; create workers only via `createWorker`.
