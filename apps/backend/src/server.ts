import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createContainer } from './container.js';
import { loadConfig } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { Database } from './infrastructure/database/database.js';
import { closeRedisClient, createRedisClient } from './infrastructure/redis/redis.js';
import {
  bindProcessShutdown,
  createGracefulShutdown,
} from './shared/lifecycle/graceful-shutdown.js';
import { createLogger } from './shared/logger/logger.js';

/**
 * HTTP API process entry point: configuration → infrastructure → app → listen.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    service: 'api',
  });

  const database = Database.fromConfig(config.database);
  const redis = createRedisClient(config.redis, { connectionName: 'api' }, logger);

  const container = createContainer({ config, db: database, redis, logger });

  let shuttingDown = false;
  const app = createApp({
    logger,
    apiRouter: container.apiRouter,
    trustProxy: config.http.trustProxy,
    bodyLimit: config.http.bodyLimit,
    healthCheckTimeoutMs: config.lifecycle.healthCheckTimeoutMs,
    isShuttingDown: () => shuttingDown,
    healthChecks: [
      { name: 'database', check: () => database.ping() },
      {
        name: 'redis',
        check: async () => {
          await redis.ping();
        },
      },
    ],
  });

  const server = createServer(app);
  // Must exceed any upstream proxy/load balancer idle timeout to avoid 502s on reused sockets.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const shutdown = createGracefulShutdown({
    logger,
    timeoutMs: config.lifecycle.shutdownTimeoutMs,
    tasks: [
      {
        name: 'http-server',
        close: () =>
          new Promise<void>((resolve, reject) => {
            shuttingDown = true;
            server.close((err) => {
              if (err === undefined) resolve();
              else reject(err);
            });
            // Idle keep-alive sockets would otherwise hold close() open until they time out.
            server.closeIdleConnections();
          }),
      },
      { name: 'redis', close: () => closeRedisClient(redis) },
      { name: 'mysql', close: () => database.close() },
    ],
  });
  bindProcessShutdown(shutdown, logger);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ host: config.http.host, port: config.http.port, env: config.env }, 'API listening');
}

main().catch((err: unknown) => {
  // The logger may not exist yet (e.g. invalid configuration), so write to stderr directly.
  process.stderr.write(
    `Fatal startup error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
