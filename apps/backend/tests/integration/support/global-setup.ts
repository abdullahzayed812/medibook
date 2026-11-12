import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import { buildPoolOptions } from '../../../src/infrastructure/database/database.js';
import { Migrator } from '../../../src/infrastructure/database/migrations/migrator.js';
import { silentLogger } from '../../../src/test-support/silent-logger.js';
import { integrationConfig } from './config.js';

/** Applies the real migrations to the test database once per integration run. */
export default async function setup(): Promise<void> {
  const {
    connectionLimit: _l,
    waitForConnections: _w,
    queueLimit: _q,
    ...options
  } = buildPoolOptions(integrationConfig().database);
  const connection = await createConnection({ ...options, multipleStatements: true });
  try {
    await new Migrator(
      connection,
      fileURLToPath(new URL('../../../migrations/', import.meta.url)),
      silentLogger(),
    ).up();
  } finally {
    await connection.end();
  }
}
