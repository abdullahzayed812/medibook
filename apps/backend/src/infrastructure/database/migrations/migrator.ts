import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { Logger } from '../../../shared/logger/logger.js';

/**
 * Forward-only, versioned SQL migrations.
 *
 * - Files live in `apps/backend/migrations` and are named `<14-digit UTC timestamp>_<snake_name>.sql`.
 * - Applied migrations are recorded in `schema_migrations` with a SHA-256 checksum.
 * - Editing an applied file, deleting it, or adding a file older than the newest applied one
 *   is rejected: published migrations are immutable; fix forward with a new migration.
 * - A MySQL named lock prevents concurrent runs (e.g. several containers starting at once).
 *
 * Note: MySQL DDL statements commit implicitly, so a migration is NOT atomic. Keep one logical
 * change per file so a failure is easy to diagnose and repair.
 */

export const MIGRATIONS_TABLE = 'schema_migrations';
const LOCK_NAME = 'medibook:schema_migrations';
const LOCK_TIMEOUT_SECONDS = 60;
const FILENAME_PATTERN = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatusEntry {
  readonly version: string;
  readonly name: string;
  readonly state: 'applied' | 'pending';
  readonly appliedAt?: Date;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function parseMigrationFilename(
  filename: string,
): { version: string; name: string } | undefined {
  const match = FILENAME_PATTERN.exec(filename);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { version: match[1], name: match[2] };
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** True when the file contains nothing but whitespace and SQL comments. */
function isEffectivelyEmpty(sql: string): boolean {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(--|#).*$/gm, '');
  return withoutComments.trim().length === 0;
}

/** Reads, validates and sorts migration files. Non-`.sql` files (e.g. README.md) are ignored. */
export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory);
  const files: MigrationFile[] = [];
  const seenVersions = new Map<string, string>();

  for (const filename of entries.filter((entry) => entry.endsWith('.sql')).sort()) {
    const parsed = parseMigrationFilename(filename);
    if (parsed === undefined) {
      throw new MigrationError(
        `Invalid migration filename "${filename}". Expected <YYYYMMDDHHMMSS>_<snake_case_name>.sql`,
      );
    }
    const duplicate = seenVersions.get(parsed.version);
    if (duplicate !== undefined) {
      throw new MigrationError(
        `Duplicate migration version ${parsed.version}: "${duplicate}" and "${filename}"`,
      );
    }
    seenVersions.set(parsed.version, filename);

    const sql = await readFile(join(directory, filename), 'utf8');
    if (isEffectivelyEmpty(sql)) {
      throw new MigrationError(`Migration "${filename}" contains no SQL statements`);
    }
    files.push({ ...parsed, filename, sql, checksum: checksum(sql) });
  }
  return files;
}

/**
 * Pure planning step: verifies history integrity and returns the pending migrations in order.
 */
export function planMigrations(
  files: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): MigrationFile[] {
  const filesByVersion = new Map(files.map((file) => [file.version, file]));

  for (const record of applied) {
    const file = filesByVersion.get(record.version);
    if (file === undefined) {
      throw new MigrationError(
        `Applied migration ${record.version}_${record.name} is missing from the migrations directory`,
      );
    }
    if (file.checksum !== record.checksum) {
      throw new MigrationError(
        `Checksum mismatch for applied migration "${file.filename}". ` +
          'Applied migrations must not be modified; create a new migration instead.',
      );
    }
  }

  const appliedVersions = new Set(applied.map((record) => record.version));
  const latestApplied = applied.reduce<string | undefined>(
    (latest, record) => (latest === undefined || record.version > latest ? record.version : latest),
    undefined,
  );
  const pending = files.filter((file) => !appliedVersions.has(file.version));

  if (latestApplied !== undefined) {
    const outOfOrder = pending.filter((file) => file.version < latestApplied);
    if (outOfOrder.length > 0) {
      throw new MigrationError(
        `Pending migration(s) older than the latest applied version ${latestApplied}: ` +
          `${outOfOrder.map((file) => file.filename).join(', ')}. Rename them with a newer timestamp.`,
      );
    }
  }
  return pending;
}

interface AppliedMigrationRow extends RowDataPacket {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

/**
 * Runs migrations over a dedicated connection. The connection MUST be created with
 * `multipleStatements: true` (migration files may contain several statements); the
 * application pool never enables that option.
 */
export interface MigratorOptions {
  /**
   * History table name. Defaults to `schema_migrations`; overridden only by the migrator's own
   * integration tests so they never touch the real migration history.
   */
  readonly table?: string;
}

export class Migrator {
  private readonly table: string;

  constructor(
    private readonly connection: Connection,
    private readonly directory: string,
    private readonly logger: Logger,
    options: MigratorOptions = {},
  ) {
    this.table = options.table ?? MIGRATIONS_TABLE;
    if (!/^[a-z_][a-z0-9_]{0,63}$/.test(this.table)) {
      throw new MigrationError(`Invalid migrations table name "${this.table}"`);
    }
  }

  /** Applies all pending migrations. Returns the applied files. */
  async up(): Promise<MigrationFile[]> {
    return this.withLock(async () => {
      await this.ensureMigrationsTable();
      const files = await readMigrationFiles(this.directory);
      const pending = planMigrations(files, await this.loadApplied());

      if (pending.length === 0) {
        this.logger.info('Database schema is up to date');
        return [];
      }

      for (const migration of pending) {
        this.logger.info({ migration: migration.filename }, 'Applying migration');
        const startedAt = performance.now();
        try {
          await this.connection.query(migration.sql);
        } catch (err) {
          throw new MigrationError(
            `Migration "${migration.filename}" failed: ${err instanceof Error ? err.message : String(err)}. ` +
              'DDL is not transactional in MySQL; inspect the schema before retrying.',
          );
        }
        const executionMs = Math.round(performance.now() - startedAt);
        await this.connection.execute(
          `INSERT INTO ${this.table} (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)`,
          [migration.version, migration.name, migration.checksum, executionMs],
        );
        this.logger.info({ migration: migration.filename, executionMs }, 'Migration applied');
      }
      return pending;
    });
  }

  /** Lists every known migration with its state, after verifying history integrity. */
  async status(): Promise<MigrationStatusEntry[]> {
    await this.ensureMigrationsTable();
    const files = await readMigrationFiles(this.directory);
    const applied = await this.loadApplied();
    planMigrations(files, applied);
    const appliedByVersion = new Map(applied.map((record) => [record.version, record]));

    return files.map((file) => {
      const record = appliedByVersion.get(file.version);
      return record === undefined
        ? { version: file.version, name: file.name, state: 'pending' }
        : { version: file.version, name: file.name, state: 'applied', appliedAt: record.appliedAt };
    });
  }

  private async ensureMigrationsTable(): Promise<void> {
    await this.connection.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        version      CHAR(14)     NOT NULL,
        name         VARCHAR(255) NOT NULL,
        checksum     CHAR(64)     NOT NULL,
        execution_ms INT UNSIGNED NOT NULL,
        applied_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  private async loadApplied(): Promise<AppliedMigration[]> {
    const [rows] = await this.connection.query<AppliedMigrationRow[]>(
      `SELECT version, name, checksum, applied_at FROM ${this.table} ORDER BY version`,
    );
    return rows.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const [rows] = await this.connection.query<RowDataPacket[]>(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [LOCK_NAME, LOCK_TIMEOUT_SECONDS],
    );
    // GET_LOCK returns BIGINT, which the connection reports as a string (bigNumberStrings).
    if (Number(rows[0]?.acquired) !== 1) {
      throw new MigrationError(
        `Could not acquire migration lock within ${LOCK_TIMEOUT_SECONDS}s; is another migration running?`,
      );
    }
    try {
      return await fn();
    } finally {
      await this.connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    }
  }
}

/** UTC timestamp in the `YYYYMMDDHHMMSS` format used as the migration version. */
export function formatMigrationVersion(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** Creates a new, intentionally empty migration file and returns its path. */
export async function createMigrationFile(
  directory: string,
  name: string,
  now: Date = new Date(),
): Promise<string> {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)) {
    throw new MigrationError(
      `Invalid migration name "${name}". Use snake_case, e.g. create_clinics`,
    );
  }
  const filename = `${formatMigrationVersion(now)}_${name}.sql`;
  const path = join(directory, filename);
  const template = [
    `-- Migration: ${name}`,
    `-- Created:   ${now.toISOString()}`,
    '--',
    '-- Forward-only. Once applied in any shared environment this file must never change.',
    '-- Keep one logical change per migration (MySQL DDL commits implicitly).',
    '-- See docs/development/DATABASE_MIGRATIONS.md.',
    '',
    '',
  ].join('\n');
  await writeFile(path, template, { flag: 'wx' });
  return path;
}
