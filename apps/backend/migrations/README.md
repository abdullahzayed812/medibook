# Database migrations

Forward-only, versioned SQL files applied by `npm run migrate`.

- Create: `npm run migrate:create -- <snake_case_name>` → `YYYYMMDDHHMMSS_<name>.sql` (UTC).
- Apply: `npm run migrate` · Inspect: `npm run migrate:status`.
- The runner records a SHA-256 checksum per applied file and refuses to continue if an applied
  file changes or disappears.
- **Policy:** never edit a migration that has been applied to a shared, Staging or Production
  database; fix forward with a new file. Before the first Production release, an unreleased
  migration applied only to disposable local databases may be amended, and those databases
  must then be rebuilt. See
  [docs/development/DATABASE_MIGRATIONS.md](../../../docs/development/DATABASE_MIGRATIONS.md).

Task 02 (`140001`–`140020`) and Task 03 (`150001`–`150025`) migrations are described in
[IDENTITY_SCHEMA.md](../../../docs/database/IDENTITY_SCHEMA.md) and
[PLATFORM_DATABASE_SCHEMA.md](../../../docs/database/PLATFORM_DATABASE_SCHEMA.md).
