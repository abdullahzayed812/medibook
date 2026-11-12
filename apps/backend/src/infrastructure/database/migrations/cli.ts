import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import { loadDatabaseConfig } from '../../../config/env.js';
import { loadEnvFile } from '../../../config/load-env-file.js';
import { createLogger } from '../../../shared/logger/logger.js';
import { buildPoolOptions } from '../database.js';
import { createMigrationFile, Migrator } from './migrator.js';

/**
 * Migration CLI.
 *   up              apply all pending migrations
 *   status          list applied / pending migrations
 *   create <name>   create a new empty migration file
 *
 * Same relative depth from src/ and dist/, so this resolves to apps/backend/migrations in both.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../migrations/', import.meta.url));

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'create') {
    const name = args[0];
    if (name === undefined) throw new Error('Usage: migrate:create <snake_case_name>');
    const path = await createMigrationFile(MIGRATIONS_DIR, name);
    process.stdout.write(`Created ${path}\n`);
    return;
  }

  if (command !== 'up' && command !== 'status') {
    throw new Error(`Unknown command "${command ?? ''}". Expected: up | status | create <name>`);
  }

  loadEnvFile();
  const config = loadDatabaseConfig();
  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    service: 'migrations',
  });
  const {
    connectionLimit: _limit,
    waitForConnections: _wait,
    queueLimit: _queue,
    ...connectionOptions
  } = buildPoolOptions(config.database);
  const connection = await createConnection({ ...connectionOptions, multipleStatements: true });

  try {
    const migrator = new Migrator(connection, MIGRATIONS_DIR, logger);
    if (command === 'up') {
      const applied = await migrator.up();
      logger.info({ count: applied.length }, 'Migrations finished');
    } else {
      const entries = await migrator.status();
      if (entries.length === 0) process.stdout.write('No migrations found.\n');
      for (const entry of entries) {
        const when = entry.appliedAt?.toISOString() ?? '';
        process.stdout.write(`${entry.state.padEnd(8)} ${entry.version}_${entry.name} ${when}\n`);
      }
    }
  } finally {
    await connection.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
