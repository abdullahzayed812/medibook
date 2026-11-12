import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/infrastructure/database/database.js';
import { integrationConfig } from '../support/config.js';

interface ItemRow {
  id: string;
  name: string;
}

const TABLE = 'it_database_items';

describe('Database (MySQL integration)', () => {
  let db: Database;

  beforeAll(async () => {
    db = Database.fromConfig(integrationConfig().database);
    await db.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.execute(
      `CREATE TABLE ${TABLE} (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL)`,
    );
  });

  beforeEach(async () => {
    await db.execute(`DELETE FROM ${TABLE}`);
  });

  afterAll(async () => {
    await db.execute(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.close();
  });

  it('pings the server', async () => {
    await expect(db.ping()).resolves.toBeUndefined();
  });

  it('runs parameterized writes and reads', async () => {
    const result = await db.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, ['Alpha']);
    expect(result.affectedRows).toBe(1);
    const rows = await db.query<ItemRow>(`SELECT id, name FROM ${TABLE} WHERE name = ?`, ['Alpha']);
    expect(rows).toHaveLength(1);
    // BIGINT values are returned as strings (bigNumberStrings) to avoid precision loss.
    expect(typeof rows[0]!.id).toBe('string');
  });

  it('treats injected SQL in parameters as plain data', async () => {
    const malicious = "x'; DROP TABLE it_database_items; --";
    await db.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, [malicious]);
    const rows = await db.query<ItemRow>(`SELECT name FROM ${TABLE}`);
    expect(rows.map((r) => r.name)).toEqual([malicious]);
  });

  it('rejects multiple statements on application connections', async () => {
    await expect(db.query('SELECT 1; SELECT 2')).rejects.toThrow();
  });

  it('commits a successful transaction', async () => {
    const value = await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, ['a']);
      await tx.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, ['b']);
      return 'done';
    });
    expect(value).toBe('done');
    expect(await db.query(`SELECT id FROM ${TABLE}`)).toHaveLength(2);
  });

  it('rolls back a failed transaction and rethrows the original error', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, ['a']);
        throw new Error('business rule violated');
      }),
    ).rejects.toThrow('business rule violated');
    expect(await db.query(`SELECT id FROM ${TABLE}`)).toHaveLength(0);
  });

  it('sees its own uncommitted writes inside the transaction only', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`INSERT INTO ${TABLE} (name) VALUES (?)`, ['pending']);
      expect(await tx.query(`SELECT id FROM ${TABLE}`)).toHaveLength(1);
      expect(await db.query(`SELECT id FROM ${TABLE}`)).toHaveLength(0);
    });
  });
});
