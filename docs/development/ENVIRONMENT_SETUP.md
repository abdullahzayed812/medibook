# Environment setup

> **Purpose:** how to set up, run and troubleshoot the local development environment.

## Prerequisites

| Tool           | Version                                                  |
| -------------- | -------------------------------------------------------- |
| Node.js        | 20 LTS, **≥ 20.19** (`.nvmrc`; `engine-strict` enforced) |
| npm            | ≥ 10 (pnpm/yarn are not used)                            |
| Docker         | Engine 24+ with Compose v2 (`docker compose`)            |
| OpenSSL (opt.) | To generate local secrets                                |

## 1. Install dependencies

```bash
nvm use            # optional, picks Node from .nvmrc
npm install        # installs every workspace; commit package-lock.json changes
```

## 2. Configure the Docker environment

```bash
cp .env.example .env
```

Fill in **every empty value**. Compose refuses to start while a required variable is missing.
Generate secrets locally, for example:

```bash
openssl rand -hex 24        # database / Redis passwords
npm run secrets:generate    # prints AUTH_SECRET, AUTH_ACCESS_TOKEN_PRIVATE_KEY,
                            # AUTH_ACCESS_TOKEN_KEY_ID and MFA_ENCRYPTION_KEY lines to paste
```

Never commit `.env`. If a host port is already in use, change `BACKEND_HOST_PORT`,
`MYSQL_HOST_PORT` or `REDIS_HOST_PORT`. All published ports bind to `127.0.0.1` only.

## 3. Start the stack

```bash
docker compose up -d --build                 # backend + mysql + redis
docker compose --profile worker up -d        # additionally start the background worker
docker compose ps                            # all services should become "healthy"
docker compose logs -f backend
```

The backend container runs `tsx watch` with `apps/backend/src` bind-mounted, so code changes
reload automatically. After changing dependencies, rebuild: `docker compose up -d --build`.

On first start of an empty MySQL volume, `infrastructure/mysql/init/01-create-test-database.sh`
creates `<MYSQL_DATABASE>_test` for integration tests. To re-run init scripts, remove the volume:
`docker compose down -v` (**deletes all local data**).

Verify:

```bash
curl -i http://127.0.0.1:3000/health          # liveness
curl -i http://127.0.0.1:3000/health/ready    # readiness (MySQL + Redis)
```

## 4. Migrations

```bash
docker compose exec backend npm run migrate          # apply pending migrations
docker compose exec backend npm run migrate:status
npm run migrate:create -- create_example_table       # creates apps/backend/migrations/<ts>_create_example_table.sql
```

Migrations are **never** run automatically on application start (see DECISIONS.md, ADR-007).
Policy, rebuilding the disposable dev/test databases and failure handling are covered in
[DATABASE_MIGRATIONS.md](DATABASE_MIGRATIONS.md).

## 5. Running the backend on the host (optional)

Useful for debugging. MySQL and Redis still run in Docker.

```bash
cp apps/backend/.env.example apps/backend/.env
# DB_PASSWORD / REDIS_PASSWORD must match the root .env;
# DB_PORT / REDIS_PORT must match MYSQL_HOST_PORT / REDIS_HOST_PORT;
# use a different HTTP_PORT if the backend container already uses 3000.
npm run dev            # API
npm run dev:worker     # worker
npm run migrate        # migrations from the host
npm run test:integration
```

The backend loads `apps/backend/.env` (from its working directory) when present. Real
environment variables take precedence.

## 6. Configuration reference

All variables are validated at startup (`apps/backend/src/config/env.ts`). Invalid or missing
values stop the process with a list of offending variable names (values are never printed).
Empty values count as unset.

| Variable                                            | Required | Default                     | Notes                                                                                               |
| --------------------------------------------------- | -------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                          | no       | `development`               | `development` \| `test` \| `production`                                                             |
| `HTTP_HOST`                                         | no       | `0.0.0.0`                   |                                                                                                     |
| `HTTP_PORT`                                         | no       | `3000`                      |                                                                                                     |
| `HTTP_BODY_LIMIT`                                   | no       | `1mb`                       | Max JSON body size                                                                                  |
| `LOG_LEVEL`                                         | no       | `info`                      | `fatal`…`trace`, `silent`                                                                           |
| `LOG_PRETTY`                                        | no       | `false`                     | `true` only for local development                                                                   |
| `DB_HOST`                                           | **yes**  |                             |                                                                                                     |
| `DB_PORT`                                           | no       | `3306`                      |                                                                                                     |
| `DB_USER`                                           | **yes**  |                             |                                                                                                     |
| `DB_PASSWORD`                                       | **yes**  |                             |                                                                                                     |
| `DB_NAME`                                           | **yes**  |                             | Letters, digits, `_`                                                                                |
| `DB_CONNECTION_LIMIT`                               | no       | `10`                        | Pool size per process                                                                               |
| `DB_CONNECT_TIMEOUT_MS`                             | no       | `10000`                     |                                                                                                     |
| `REDIS_HOST`                                        | **yes**  |                             |                                                                                                     |
| `REDIS_PORT`                                        | no       | `6379`                      |                                                                                                     |
| `REDIS_PASSWORD`                                    | no       |                             | Required by the Compose Redis                                                                       |
| `REDIS_DB`                                          | no       | `0`                         |                                                                                                     |
| `QUEUE_PREFIX`                                      | no       | `medibook`                  | BullMQ key prefix                                                                                   |
| `SHUTDOWN_TIMEOUT_MS`                               | no       | `15000`                     | Hard deadline for graceful shutdown                                                                 |
| `HEALTH_CHECK_TIMEOUT_MS`                           | no       | `2000`                      | Per-dependency timeout for `/health/ready`                                                          |
| `HTTP_TRUST_PROXY`                                  | no       | `false`                     | Express `trust proxy` (hop count, subnet list, `true`/`false`); determines `req.ip` for rate limits |
| `AUTH_SECRET`                                       | **yes**  |                             | ≥ 32 chars; HKDF master secret for OTP / recovery-code / subject hashes                             |
| `AUTH_ACCESS_TOKEN_PRIVATE_KEY`                     | **yes**  |                             | base64 of an Ed25519 PKCS#8 PEM (`npm run secrets:generate`)                                        |
| `AUTH_ACCESS_TOKEN_KEY_ID`                          | **yes**  |                             | `kid` of the signing key                                                                            |
| `AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY` / `_KEY_ID` | no       |                             | previous key during rotation (set both)                                                             |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`                     | no       | `medibook` / `medibook-api` | JWT `iss` / `aud`                                                                                   |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                     | no       | `900`                       | 60–3600                                                                                             |
| `AUTH_REFRESH_TOKEN_TTL_SECONDS`                    | no       | `2592000`                   | ≤ session lifetime                                                                                  |
| `AUTH_SESSION_MAX_LIFETIME_SECONDS`                 | no       | `7776000`                   | absolute session lifetime                                                                           |
| `OTP_PROVIDER`                                      | **yes**  |                             | only `mock` exists; **rejected when `NODE_ENV=production`**                                         |
| `OTP_TTL_SECONDS`                                   | no       | `300`                       |                                                                                                     |
| `OTP_MAX_ATTEMPTS`                                  | no       | `5`                         | per challenge                                                                                       |
| `OTP_RESEND_COOLDOWN_SECONDS`                       | no       | `60`                        | per phone                                                                                           |
| `OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR`               | no       | `5`                         |                                                                                                     |
| `OTP_MAX_REQUESTS_PER_IP_PER_HOUR`                  | no       | `30`                        |                                                                                                     |
| `OTP_MAX_VERIFICATIONS_PER_IP_PER_15_MIN`           | no       | `30`                        |                                                                                                     |
| `PHONE_DEFAULT_REGION`                              | no       |                             | ISO alpha-2; unset = only `+`-prefixed numbers accepted                                             |
| `MFA_ENCRYPTION_KEY`                                | **yes**  |                             | base64, exactly 32 bytes (AES-256-GCM for TOTP secrets)                                             |
| `MFA_TOTP_ISSUER`                                   | no       | `MediBook`                  | shown in authenticator apps                                                                         |
| `MFA_MAX_VERIFICATIONS_PER_15_MIN`                  | no       | `5`                         | per user                                                                                            |
| `PRIVATE_STORAGE_PROVIDER`                          | no       | `local`                     | only `local` (dev/test disk) exists; **rejected when `NODE_ENV=production`** until R2 is integrated |
| `PRIVATE_STORAGE_LOCAL_DIR`                         | no       | `.private-storage`          | relative to the backend working directory; git-ignored                                              |

The migration CLI only needs the `DB_*` and `LOG_*` variables.

## 7. Development login and first super admin

1. `POST /api/v1/auth/otp/request` with `{ "phone": "+1202555…" }`. The mock provider prints the
   code in the backend log (`docker compose logs backend | grep devOtp`). Dev only; impossible in
   production.
2. `POST /api/v1/auth/otp/verify` with the challenge id, phone, code and a `device` object.
3. Bootstrap a super admin for an existing account:
   `docker compose exec backend npm run role:grant -- +1202555… SUPER_ADMIN`, then enroll TOTP
   through `/api/v1/security/mfa/totp/enrollment`.

Use synthetic numbers only (e.g. the fictional `+1 202 555 01xx` range).

## 8. Troubleshooting

- **`required variable … is missing a value`**: fill in `.env` (step 2).
- **Port already allocated**: change the `*_HOST_PORT` values in `.env`.
- **Integration tests fail with `Access denied … medibook_test`**: the MySQL volume was created
  before the init script existed. Run `docker compose down -v && docker compose up -d`.
- **`Could not acquire migration lock`**: another migration run holds the lock; wait or check
  for a stuck process.
