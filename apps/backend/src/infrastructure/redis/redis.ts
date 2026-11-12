import { Redis, type RedisOptions } from 'ioredis';
import type { AppConfig } from '../../config/env.js';
import type { Logger } from '../../shared/logger/logger.js';

export type { Redis } from 'ioredis';

export interface RedisClientOptions {
  /** Connection name shown in `CLIENT LIST`, useful when debugging. */
  readonly connectionName: string;
  /**
   * BullMQ workers use blocking commands and require `maxRetriesPerRequest: null`.
   * Regular clients keep a finite retry count so requests fail fast when Redis is down.
   */
  readonly forBullMQ?: boolean;
}

export function buildRedisOptions(
  config: AppConfig['redis'],
  options: RedisClientOptions,
): RedisOptions {
  return {
    host: config.host,
    port: config.port,
    db: config.db,
    ...(config.password === undefined ? {} : { password: config.password }),
    connectionName: options.connectionName,
    maxRetriesPerRequest: options.forBullMQ === true ? null : 3,
    enableReadyCheck: true,
    // Exponential backoff capped at 5s; ioredis keeps reconnecting until closed.
    retryStrategy: (attempt) => Math.min(2 ** attempt * 100, 5_000),
  };
}

export function createRedisClient(
  config: AppConfig['redis'],
  options: RedisClientOptions,
  logger: Logger,
): Redis {
  const client = new Redis(buildRedisOptions(config, options));
  const log = logger.child({ redis: options.connectionName });
  client.on('ready', () => {
    log.info('Redis connection ready');
  });
  client.on('reconnecting', (delayMs: number) => {
    log.warn({ delayMs }, 'Redis reconnecting');
  });
  // Without an 'error' listener ioredis errors would be reported as unhandled.
  client.on('error', (err: Error) => {
    log.error({ err }, 'Redis connection error');
  });
  return client;
}

/** Closes the connection gracefully (QUIT), falling back to a hard disconnect. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
