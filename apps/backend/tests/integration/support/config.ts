import { loadConfig, type AppConfig } from '../../../src/config/env.js';
import { loadEnvFile } from '../../../src/config/load-env-file.js';
import { testAuthEnv } from '../../../src/test-support/auth-env.js';

/**
 * Integration test configuration. Reads the normal environment (or apps/backend/.env) for
 * connection settings and ALWAYS switches to the dedicated `<DB_NAME>_test` database, so
 * integration tests can never modify development data. Auth secrets are generated per run.
 */
export function integrationConfig(overrides: Record<string, string> = {}): AppConfig {
  loadEnvFile();
  const base = loadConfig({
    ...process.env,
    ...testAuthEnv(),
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: 'false',
    ...overrides,
  });
  return { ...base, database: { ...base.database, database: `${base.database.database}_test` } };
}
