import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPoolOptions } from '../../../src/infrastructure/database/database.js';
import { Migrator } from '../../../src/infrastructure/database/migrations/migrator.js';
import { silentLogger } from '../../../src/test-support/silent-logger.js';
import { integrationConfig } from '../support/config.js';

const TABLES = ['it_migr_one', 'it_migr_two'];
// Separate history table: the real `schema_migrations` in the test database must stay intact.
const HISTORY_TABLE = 'it_schema_migrations';

describe('Migrator (MySQL integration)', () => {
  let connection: Connection;
  let dir: string;

  async function reset(): Promise<void> {
    for (const table of [...TABLES, HISTORY_TABLE]) {
      await connection.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  async function tableExists(table: string): Promise<boolean> {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [table],
    );
    return Number(rows[0]?.n) === 1;
  }

  beforeAll(async () => {
    const {
      connectionLimit: _l,
      waitForConnections: _w,
      queueLimit: _q,
      ...options
    } = buildPoolOptions(integrationConfig().database);
    connection = await createConnection({ ...options, multipleStatements: true });
  });

  beforeEach(async () => {
    await reset();
    dir = await mkdtemp(join(tmpdir(), 'medibook-it-migrations-'));
  });

  afterAll(async () => {
    await reset();
    await connection.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('applies pending migrations in order and records them', async () => {
    await writeFile(
      join(dir, '20260101000000_one.sql'),
      'CREATE TABLE it_migr_one (id INT PRIMARY KEY);',
    );
    await writeFile(
      join(dir, '20260102000000_two.sql'),
      'CREATE TABLE it_migr_two (id INT PRIMARY KEY);\nINSERT INTO it_migr_two VALUES (1);',
    );
    const migrator = new Migrator(connection, dir, silentLogger(), { table: HISTORY_TABLE });

    const applied = await migrator.up();
    expect(applied.map((m) => m.name)).toEqual(['one', 'two']);
    expect(await tableExists('it_migr_one')).toBe(true);
    expect(await tableExists('it_migr_two')).toBe(true);

    const status = await migrator.status();
    expect(status.map((s) => s.state)).toEqual(['applied', 'applied']);
  });

  it('is idempotent', async () => {
    await writeFile(
      join(dir, '20260101000000_one.sql'),
      'CREATE TABLE it_migr_one (id INT PRIMARY KEY);',
    );
    const migrator = new Migrator(connection, dir, silentLogger(), { table: HISTORY_TABLE });
    await migrator.up();
    expect(await migrator.up()).toEqual([]);
  });

  it('reports pending migrations in status', async () => {
    await writeFile(
      join(dir, '20260101000000_one.sql'),
      'CREATE TABLE it_migr_one (id INT PRIMARY KEY);',
    );
    const status = await new Migrator(connection, dir, silentLogger(), {
      table: HISTORY_TABLE,
    }).status();
    expect(status).toEqual([{ version: '20260101000000', name: 'one', state: 'pending' }]);
  });

  it('refuses to run when an applied migration was modified', async () => {
    const path = join(dir, '20260101000000_one.sql');
    await writeFile(path, 'CREATE TABLE it_migr_one (id INT PRIMARY KEY);');
    const migrator = new Migrator(connection, dir, silentLogger(), { table: HISTORY_TABLE });
    await migrator.up();
    await writeFile(path, 'CREATE TABLE it_migr_one (id BIGINT PRIMARY KEY);');
    await expect(migrator.up()).rejects.toThrow(/Checksum mismatch/);
  });

  it('stops at a failing migration without recording it', async () => {
    await writeFile(
      join(dir, '20260101000000_one.sql'),
      'CREATE TABLE it_migr_one (id INT PRIMARY KEY);',
    );
    await writeFile(join(dir, '20260102000000_two.sql'), 'THIS IS NOT SQL;');
    const migrator = new Migrator(connection, dir, silentLogger(), { table: HISTORY_TABLE });
    await expect(migrator.up()).rejects.toThrow(/20260102000000_two\.sql/);
    const status = await migrator.status();
    expect(status.map((s) => s.state)).toEqual(['applied', 'pending']);
  });
});
