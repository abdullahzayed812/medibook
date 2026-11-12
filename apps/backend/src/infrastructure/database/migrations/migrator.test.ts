import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppliedMigration,
  checksum,
  createMigrationFile,
  formatMigrationVersion,
  MigrationError,
  type MigrationFile,
  parseMigrationFilename,
  planMigrations,
  readMigrationFiles,
} from './migrator.js';

function file(version: string, sql = `SELECT ${version}`): MigrationFile {
  return { version, name: 'test', filename: `${version}_test.sql`, sql, checksum: checksum(sql) };
}

function applied(migration: MigrationFile): AppliedMigration {
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
    appliedAt: new Date(),
  };
}

describe('parseMigrationFilename', () => {
  it('parses valid names', () => {
    expect(parseMigrationFilename('20261111120000_create_clinics.sql')).toEqual({
      version: '20261111120000',
      name: 'create_clinics',
    });
  });

  it.each([
    '2026_create.sql',
    '20261111120000-create.sql',
    '20261111120000_Create.sql',
    '20261111120000_create.SQL',
    '20261111120000_.sql',
    '20261111120000_create__x.sql',
  ])('rejects %s', (name) => {
    expect(parseMigrationFilename(name)).toBeUndefined();
  });
});

describe('checksum', () => {
  it('is stable across line-ending styles', () => {
    expect(checksum('SELECT 1;\r\nSELECT 2;')).toBe(checksum('SELECT 1;\nSELECT 2;'));
  });
});

describe('planMigrations', () => {
  const a = file('20260101000000');
  const b = file('20260102000000');
  const c = file('20260103000000');

  it('returns all files when nothing is applied', () => {
    expect(planMigrations([a, b], [])).toEqual([a, b]);
  });

  it('returns only pending files', () => {
    expect(planMigrations([a, b, c], [applied(a)])).toEqual([b, c]);
  });

  it('rejects modified applied migrations', () => {
    const changed = { ...a, checksum: checksum('SELECT 999') };
    expect(() => planMigrations([changed], [applied(a)])).toThrow(/Checksum mismatch/);
  });

  it('rejects applied migrations missing from disk', () => {
    expect(() => planMigrations([b], [applied(a)])).toThrow(/missing/);
  });

  it('rejects pending migrations older than the latest applied one', () => {
    expect(() => planMigrations([a, b, c], [applied(a), applied(c)])).toThrow(MigrationError);
  });
});

describe('migration files on disk', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'medibook-migrations-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads .sql files sorted by version and ignores other files', async () => {
    await writeFile(join(dir, '20260102000000_second.sql'), 'SELECT 2;');
    await writeFile(join(dir, '20260101000000_first.sql'), 'SELECT 1;');
    await writeFile(join(dir, 'README.md'), '# docs');
    const files = await readMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['first', 'second']);
  });

  it('rejects invalid filenames', async () => {
    await writeFile(join(dir, 'oops.sql'), 'SELECT 1;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/Invalid migration filename/);
  });

  it('rejects duplicate versions', async () => {
    await writeFile(join(dir, '20260101000000_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '20260101000000_b.sql'), 'SELECT 2;');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/Duplicate migration version/);
  });

  it('rejects files containing only comments', async () => {
    await writeFile(join(dir, '20260101000000_empty.sql'), '-- nothing\n/* still nothing */\n');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/no SQL statements/);
  });

  it('creates a timestamped template that must be filled in before running', async () => {
    const now = new Date('2026-11-11T09:08:07.000Z');
    expect(formatMigrationVersion(now)).toBe('20261111090807');
    const path = await createMigrationFile(dir, 'create_clinics', now);
    expect(path).toBe(join(dir, '20261111090807_create_clinics.sql'));
    expect(await readFile(path, 'utf8')).toContain('Forward-only');
    await expect(readMigrationFiles(dir)).rejects.toThrow(/no SQL statements/);
  });

  it('refuses to overwrite an existing migration or accept bad names', async () => {
    const now = new Date('2026-11-11T09:08:07.000Z');
    await createMigrationFile(dir, 'x', now);
    await expect(createMigrationFile(dir, 'x', now)).rejects.toThrow();
    await expect(createMigrationFile(dir, 'Bad-Name', now)).rejects.toThrow(MigrationError);
  });
});
