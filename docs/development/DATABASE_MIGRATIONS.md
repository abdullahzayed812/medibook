# Database migrations

> **Purpose:** the permanent policy for changing the MySQL schema, how the migration runner
> actually behaves, and the exact procedures for creating, running, rebuilding, validating and
> recovering. Decision record: [ADR-007](../architecture/decisions/DECISIONS.md#adr-007--forward-only-checksummed-sql-migrations-never-automatic-on-boot--accepted-task-01)
> and [ADR-036](../architecture/decisions/DECISIONS.md#adr-036-migration-policy-development-phase-consolidation-production-immutability--accepted-task-031).
> Table conventions live in [CODING_STANDARDS.md](CODING_STANDARDS.md#schema-and-migrations).

## 1. How the runner works

The runner is in-house (`apps/backend/src/infrastructure/database/migrations/migrator.ts`).
Everything below is what the code does, not an aspiration.

| Aspect            | Behaviour                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files             | `apps/backend/migrations/<YYYYMMDDHHMMSS>_<snake_case>.sql` (UTC). Non-`.sql` files are ignored. Invalid names, duplicate versions and comment-only files are rejected.   |
| Tracking          | Table `schema_migrations` (`version`, `name`, `checksum`, `execution_ms`, `applied_at`), created on first run. A row is inserted **only after** the file's SQL succeeded. |
| Checksums         | SHA-256 of the file content (CRLF normalized to LF). Every `up` **and** `status` re-verifies all applied files.                                                           |
| Refuses to run if | an applied file's checksum changed · an applied file is missing from disk · a pending file is older than the newest applied one.                                          |
| Concurrency       | MySQL named lock `medibook:schema_migrations` (`GET_LOCK`, 60 s timeout). Concurrent runs wait or fail; nothing is applied twice.                                         |
| Atomicity         | **None per file.** MySQL DDL commits implicitly, so a file that fails halfway can leave part of its changes applied, with no tracking row.                                |
| Direction         | Forward only. There are no down migrations.                                                                                                                               |
| When it runs      | Only explicitly (`npm run migrate`). Never on application start. The integration-test global setup runs it against `<DB_NAME>_test` before every integration run.         |

Editing a migration file **never** changes a database that already applied it. The runner
detects the edit and stops with `Checksum mismatch for applied migration "…"`.

## 2. Environment classes

| Class                   | Examples                                                              | May an applied migration be edited?             |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| **Disposable**          | local Docker `medibook` (dev) and `medibook_test` (integration tests) | Yes, during the development phase, then rebuild |
| **Shared / persistent** | any database another person, CI cache, demo or Staging depends on     | **No**: forward-only new migration              |
| **Production**          | production                                                            | **Never**                                       |

State on 2026-11-11 (Task 03.1): no shared, Staging or Production database exists, the
repository has no commits and no remote, and the only databases are the two local Docker
databases above.

## 3. Development-phase policy (until the first Production release)

Goal: a clean, readable history without a new file for every small adjustment.

- **Prefer amending** an existing, unreleased migration over adding a tiny new one (a single
  permission, index or minor column), when the change logically belongs there.
- **Prefer consolidating** related changes into the migration that owns that concern.
- A fresh, empty database must always be buildable from the current files alone.
- **Before amending an existing migration**, check all five:
  1. Read the runner (section 1) to confirm how tracking and checksums work.
  2. Note that applied migrations are recorded in `schema_migrations` with checksums.
  3. Confirm that checksums are enforced (they are), so every database that applied the file
     must be rebuilt.
  4. Identify every database that applied the file (`npm run migrate:status` per database).
  5. Confirm that every one of them is **disposable**. If any is shared or persistent, stop and
     write a new migration instead (section 4).
- After amending: rebuild every affected disposable database (section 6), re-run the full
  sequence, validate (section 7), and re-run the relevant test suites.
- Never delete or edit `schema_migrations` rows to "make the checksum pass".
- Do not force consolidation where it hurts clarity or consistency. A new migration is always
  acceptable.

## 4. Shared and persistent environments

- A migration applied to a shared or persistent database is **immutable**. Never edit, rename
  or delete it.
- Every change is a **new forward-only migration** with a newer timestamp.
- Keep changes backward compatible where possible (expand → migrate data → contract), so the
  previous application version still works against the new schema.
- Take a backup before migrating (section 9).
- Never reset or drop a persistent database to simplify migration management.

## 5. Production policy (permanent, from the first Production release)

- A migration released to Production is **never** edited. History is never rewritten.
- All schema changes are new forward-only migrations.
- No automatic or destructive schema synchronization, ever.
- Every migration needs a documented **execution and rollback strategy**. Because there are no
  down migrations, rollback means one of these: the application rolls back against a
  backward-compatible schema, a compensating forward migration, or a restore from backup.
- **Destructive changes** (dropping or renaming columns or tables, narrowing types, deleting
  data) need explicit review, a verified backup and a written recovery plan before they run.
- From that point the development-phase amending in section 3 no longer applies.

## 6. Procedures

### Create and run

```bash
npm run migrate:create -- add_example_column   # new empty, timestamped file (fails until filled in)
npm run migrate                                # apply pending migrations (dev DB from apps/backend/.env)
npm run migrate:status                         # applied / pending list; also verifies checksums
docker compose exec backend npm run migrate    # same, inside the backend container
```

The integration test database is migrated automatically by `npm run test:integration` (and
every `test:*` integration script).

### Rebuild disposable development and test databases

Use only for the **disposable** local databases. This deletes their data, including local
accounts (re-create a Super Admin afterwards: sign in once with OTP, then
`npm run role:grant -- <phone> SUPER_ADMIN`).

Option A drops only the two schemas (keeps the Docker volumes, users, grants and Redis):

```bash
docker compose exec mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "
  DROP DATABASE IF EXISTS medibook;      CREATE DATABASE medibook      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  DROP DATABASE IF EXISTS medibook_test; CREATE DATABASE medibook_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"'
npm run migrate              # rebuilds the dev schema
npm run test:integration     # global setup rebuilds the test schema, then runs the suites
```

Database-level grants for the application user survive `DROP DATABASE`. Replace the database
names if `MYSQL_DATABASE` is not `medibook`.

Option B removes everything, including Redis data, and re-runs the MySQL init scripts:
`docker compose down -v && docker compose up -d`, then `npm run migrate`.

## 7. Validate schema consistency

After any migration change, run all of these:

1. `npm run migrate:status`: every file is `applied`, nothing is `pending`, and there is no
   checksum error.
2. Run `npm run migrate` a second time: it must log `count: 0` (nothing is applied twice).
3. `npm run test:integration`: in particular
   `tests/integration/infrastructure/identity-schema.test.ts` asserts that the seeded roles,
   permissions and role grants match the code catalog exactly.
4. Compare the dev and test schemas. Dump columns, indexes, foreign keys, check constraints,
   `schema_migrations` checksums and the seeded catalog from `information_schema` for both
   databases and `diff` them. The output must be identical.

## 8. Migration failures

- The runner stops at the first failing file and reports
  `Migration "<file>" failed: … inspect the schema before retrying`. No tracking row is
  written for that file, and later files are not attempted.
- **Disposable database:** fix the file and rebuild (section 6).
- **Shared or Production database:** inspect what the failed file already applied. Then either
  repair the partial state by hand under review and re-run, or complete it with a new forward
  migration. Restore from backup if data is at risk. Never insert or delete tracking rows to
  skip a file without a reviewed, documented reason.
- `Checksum mismatch`: an applied file was edited. On a disposable database, rebuild. Anywhere
  else, restore the original file content and write a new migration.
- `Pending migration(s) older than the latest applied version`: rename the new file with a
  current timestamp (`migrate:create` does this).
- `Could not acquire migration lock`: another run is in progress, or a session holding the lock
  is stuck.
- Keep one logical change per file to make partial failures small and easy to diagnose.

## 9. Backup and recovery requirements

For shared, Staging and Production databases:

- **Before every migration run**, take a consistent backup (for example
  `mysqldump --single-transaction --routines --triggers`, or a managed snapshot). Record where
  it is stored and verify that it is readable.
- Periodically test restores into a scratch database. An untested backup does not count.
- Destructive changes additionally need a restore rehearsal and a written recovery plan.
- Backups contain personal and medical data. Store them encrypted, with restricted access and a
  defined retention period.

Operational backup tooling and schedules are not defined yet. They belong in
`docs/operations/` when deployment is designed.

## 10. History notes

- **Task 03.1:** `platform.specialties.manage` was folded into the unreleased
  `20261111150025_add_platform_clinic_permissions.sql` rather than added as a new file. The
  only databases that had applied it were the two disposable local ones, and both were
  rebuilt and validated.
- Comments inside already-applied migrations can mention documentation paths from before the
  Task 03.1 restructuring. For example, `20261111140007_create_role_permissions.sql` points to
  the authorization document under its old `architecture/` folder; it is now
  [security/AUTHORIZATION.md](../security/AUTHORIZATION.md).
  They are deliberately not edited, so the checksums do not change for a comment. Use
  [docs/README.md](../README.md) to find documents.
