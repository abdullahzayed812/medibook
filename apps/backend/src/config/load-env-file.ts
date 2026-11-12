import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a local `.env` file (if present) into `process.env` for host-based development.
 * In Docker and production, configuration comes from the real environment and no file exists.
 * Uses Node's built-in loader; no third-party dependency is needed.
 */
export function loadEnvFile(path = resolve(process.cwd(), '.env')): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
