# Task 01 report: Clinic SaaS technical foundation

| Field  | Value                                              |
| ------ | -------------------------------------------------- |
| Task   | 01: Establish the Clinic SaaS Technical Foundation |
| Date   | 2026-11-11                                         |
| Status | Approved (Task 02 was issued on 2026-11-11)        |
| Next   | Task 02 must not start until this task is approved |

## Summary

The monorepo, backend skeleton, database/Redis/worker infrastructure, Docker development stack
and documentation are in place. After a clean `npm ci`, every check passed: format, lint,
typecheck, 63 unit tests, 14 integration tests, build, and Docker Compose validation. One
moderate `npm audit` advisory remains in dev-only tooling (see [Known limitations](#known-limitations)).

The repository was empty before the task, so there were no conflicts with existing
configuration. `git init` was run; no commits were made.

## Created repository structure

- **Root:** npm workspaces, strict `tsconfig.base.json`, ESLint 10 flat config with type-aware
  rules, Prettier, `.editorconfig`, `.nvmrc`, `.npmrc` (`engine-strict`), `.gitignore`,
  `.dockerignore`, `docker-compose.yml`, `.env.example`.
- **`apps/backend`:**
  - `src/server.ts` (API) and `src/worker.ts` (worker): two entry points. `src/app.ts` builds
    the Express app without opening ports or connections.
  - `src/config/`, `src/shared/{errors,http,lifecycle,logger}`,
    `src/infrastructure/{database,redis,queue}`, `src/modules/health`, `src/jobs/registry.ts`.
  - `migrations/`, `tests/integration/`.
- **`apps/{admin,clinic,patient}-web`, `apps/{patient,staff}-mobile`:** placeholder workspaces
  (`package.json` and `README.md` only).
- **`packages/*` (all 6):** buildable TypeScript skeletons compiling to `dist/` with type
  declarations.
- **`infrastructure/`:** development Dockerfile and a MySQL init script that creates the
  `<MYSQL_DATABASE>_test` database.
- **`docs/`:** architecture, development (environment setup, coding standards, testing, Git
  workflow), decisions, and task reports.

## Important configuration decisions

All are recorded in [DECISIONS.md](../architecture/decisions/DECISIONS.md).

- **Versions constrained by Node 20 LTS:**
  - Vitest 4.1: Vitest 5 requires Node ≥ 22.
  - TypeScript 5.9: typescript-eslint 8 supports `<6.1`, so TypeScript 7 cannot be linted.
  - BullMQ 5 rather than v6 (released 2026-07), to stay on the proven line.
- **Libraries:** Express 5 (forwards async errors natively), zod 4 (config and request
  validation), pino + pino-http (structured logs).
- **Migrations:** small in-house runner. Forward-only, SHA-256 checksums, rejects out-of-order
  files, MySQL `GET_LOCK` against concurrent runs, never run automatically at startup. MySQL DDL
  is not transactional, so the standard is one logical change per migration.
- **Health:** `GET /health` is liveness only (used by the Docker healthcheck).
  `GET /health/ready` checks MySQL and Redis with a timeout and returns 503 during shutdown.
- **Integration tests always target `<DB_NAME>_test`**, so they cannot touch development data.
- **No credentials in the repository.** Compose uses `${VAR:?}` and refuses to start without a
  filled-in `.env`. Published ports bind to `127.0.0.1` only.

## Installed dependencies

**Backend runtime:** express 5.3, mysql2 3.24, ioredis 5.11, bullmq 5.81, pino 10.4,
pino-http 11, zod 4.6.

**Development:** typescript 5.9.3, eslint 10.14, typescript-eslint 8.72, @eslint/js,
eslint-config-prettier, prettier 3.9, globals, vitest 4.1.12, tsx 4.23, supertest 7.3,
@types/node@20, @types/express, @types/supertest, pino-pretty.

## Implemented infrastructure

- **Startup:** configuration validated with zod at startup. Invalid configuration stops the
  process with exit code 1, naming the offending variables without printing their values.
- **Errors:** centralized error handler with a single JSON error envelope
  (`{ error: { code, message, requestId, details? } }`). Body-parser errors map to 400/413/415;
  unexpected errors return a generic 500 and are logged with their stack.
- **Request handling:** zod request-validation middleware; correlation IDs via `X-Request-Id`
  (safe incoming IDs reused, otherwise UUID v4); structured JSON logs with redaction.
- **Shutdown:** graceful, sequential (API: HTTP → Redis → MySQL; worker: BullMQ workers →
  Redis → MySQL) with a hard timeout.
- **Database:** MySQL connection pool, parameterized `query`/`execute`, `transaction` helper.
  A failed rollback destroys the connection instead of returning it to the pool. Multiple
  statements are disabled on application connections.
- **Redis and worker:** Redis client factory, BullMQ queue/worker factories with default job
  options, separate worker entry point with an empty job registry.

## Commands executed and results

| Command                                                        | Result                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm ci` (clean install)                                       | ✅ No errors                                                                                              |
| `npm run format:check`                                         | ✅ First run flagged 5 docs files; fixed with Prettier, then clean                                        |
| `npm run lint`                                                 | ✅ 0 errors / 0 warnings (first run: 20 errors, all fixed; one justified inline disable in a test helper) |
| `npm run typecheck`                                            | ✅ All workspaces                                                                                         |
| `npm test`                                                     | ✅ 8 files, **63 tests passed**                                                                           |
| `npm run test:integration` (real MySQL 8.4 + Redis 7.4)        | ✅ 3 files, **14 tests passed**                                                                           |
| `npm run build`                                                | ✅ All 7 compilable workspaces; no test files in `dist`                                                   |
| `docker compose config --quiet` (default and `worker` profile) | ✅ Valid; also confirmed it fails without `.env`                                                          |
| `docker compose up -d --build`                                 | ✅ backend, mysql, redis all **healthy**; `/health/ready` reports database up, redis up                   |
| `npm run migrate` / `migrate:status` (container and host)      | ✅ "Database schema is up to date" (no migrations exist yet)                                              |
| SIGTERM to API and worker containers                           | ✅ Ordered shutdown, exit code 0                                                                          |
| Compiled `node dist/server.js` on the host                     | ✅ Serves requests, shuts down cleanly                                                                    |
| Server started with no environment                             | ✅ Exit code 1, lists missing variables                                                                   |

### Bugs found and fixed during verification

1. **Migration lock always failed.** With lossless BIGINT handling (`bigNumberStrings`),
   `GET_LOCK()` returns `"1"` (a string), so the strict comparison with `1` failed. Found by the
   integration tests; fixed with an explicit numeric conversion.
2. **Unreachable error branches.** The body-parser error detector filtered on an `entity.`
   prefix, making the `encoding.unsupported` / `charset.unsupported` (415) branches unreachable.
   Found during the lint pass; fixed and covered by a new test.

## Known limitations

- **npm audit:** one moderate advisory (minimatch ReDoS) in dev-only lint tooling (ESLint,
  typescript-eslint). The only fix offered is a downgrade to ESLint 9, so it was left as is.
- **Web and mobile apps are placeholders.** Nothing is scaffolded or installed (open decisions
  OD-01 and OD-02).
- **Health probe log noise:** the Docker healthcheck produces an info-level access log line
  every 10 seconds.
- **Correlation IDs do not yet reach service or job logs** unless a logger is passed in
  (ADR-010).
- **Not set up yet:** CI pipeline, production Docker image, Socket.IO, Cloudflare R2.
- **Local environment:** the local `.env` files (gitignored) use host ports 3307 (MySQL) and
  6381 (Redis), because 3306 and 6379 were already in use on the development machine.

## Deviations from the specification

1. **Web and mobile workspaces contain no React or React Native code.** The approved stack does
   not name a web bundler, and React Native needs a deliberate monorepo setup. Both are recorded
   as open decisions instead of inventing a choice.
2. **Optional `worker` service in Compose**, behind the `worker` profile. The default
   `docker compose up` still runs exactly backend, MySQL and Redis.
3. **`GET /health/ready` added** alongside the basic `GET /health` endpoint.
4. **Some package versions are older than the latest releases** to stay compatible with
   Node 20 LTS (listed above).

No Task 02 or authentication work was started.
