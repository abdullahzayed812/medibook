import { describe, expect, it } from 'vitest';
import { buildPoolOptions } from './database.js';

describe('buildPoolOptions', () => {
  const options = buildPoolOptions({
    host: 'db',
    port: 3306,
    user: 'app',
    password: 'pw',
    database: 'medibook',
    connectionLimit: 5,
    connectTimeoutMs: 1_000,
  });

  it('disables multiple statements on application connections', () => {
    expect(options.multipleStatements).toBe(false);
  });

  it('uses UTC, utf8mb4 and lossless big numbers', () => {
    expect(options.timezone).toBe('Z');
    expect(options.charset).toMatch(/^utf8mb4/);
    expect(options.supportBigNumbers).toBe(true);
    expect(options.bigNumberStrings).toBe(true);
  });

  it('passes pool sizing through', () => {
    expect(options.connectionLimit).toBe(5);
    expect(options.waitForConnections).toBe(true);
  });
});
