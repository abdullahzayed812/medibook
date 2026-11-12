import type { Worker } from 'bullmq';
import { loadConfig } from './config/env.js';
import { loadEnvFile } from './config/load-env-file.js';
import { Database } from './infrastructure/database/database.js';
import { createContainer } from './container.js';
import { createQueue, createWorker } from './infrastructure/queue/queue.js';
import { closeRedisClient, createRedisClient } from './infrastructure/redis/redis.js';
import { createJobDefinitions, JOB_SCHEDULES } from './jobs/registry.js';
import {
  bindProcessShutdown,
  createGracefulShutdown,
} from './shared/lifecycle/graceful-shutdown.js';
import { createLogger } from './shared/logger/logger.js';

/**
 * Background worker process entry point. Runs separately from the HTTP API so that
 * slow or CPU-heavy jobs never affect request latency, and each can scale independently.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    service: 'worker',
  });

  // MySQL stays the source of truth: jobs read and write business state through it.
  const database = Database.fromConfig(config.database);
  await database.ping();

  const connection = createRedisClient(
    config.redis,
    { connectionName: 'worker', forBullMQ: true },
    logger,
  );
  await connection.ping();

  const container = createContainer({ config, db: database, redis: connection, logger });
  const jobDefinitions = createJobDefinitions(container);
  const workers: Worker[] = jobDefinitions.map((definition) =>
    createWorker(definition, connection, { prefix: config.queue.prefix }, logger),
  );
  for (const schedule of JOB_SCHEDULES) {
    const queue = createQueue(schedule.queueName, connection, { prefix: config.queue.prefix });
    await queue.upsertJobScheduler(
      schedule.schedulerId,
      { every: schedule.everyMs },
      { name: schedule.schedulerId },
    );
    await queue.close();
  }

  const shutdown = createGracefulShutdown({
    logger,
    timeoutMs: config.lifecycle.shutdownTimeoutMs,
    tasks: [
      {
        // Stops fetching new jobs and waits for active jobs to finish.
        name: 'bullmq-workers',
        close: async () => {
          await Promise.all(workers.map((worker) => worker.close()));
        },
      },
      { name: 'redis', close: () => closeRedisClient(connection) },
      { name: 'mysql', close: () => database.close() },
    ],
  });
  bindProcessShutdown(shutdown, logger);

  if (workers.length === 0) {
    logger.warn('No job definitions registered; worker is idle');
  }
  logger.info({ queues: jobDefinitions.map((d) => d.queueName) }, 'Worker started');
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Fatal worker startup error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
