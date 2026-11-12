import { randomUUID } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createQueue, createWorker } from '../../../src/infrastructure/queue/queue.js';
import {
  closeRedisClient,
  createRedisClient,
  type Redis,
} from '../../../src/infrastructure/redis/redis.js';
import { silentLogger } from '../../../src/test-support/silent-logger.js';
import { integrationConfig } from '../support/config.js';

describe('Redis + BullMQ (integration)', () => {
  const config = integrationConfig();
  const logger = silentLogger();
  // A unique prefix isolates this run's keys from development queues and other runs.
  const settings = { prefix: `it-${randomUUID()}` };
  let client: Redis;
  let workerConnection: Redis;

  beforeAll(() => {
    client = createRedisClient(config.redis, { connectionName: 'it-client' }, logger);
    workerConnection = createRedisClient(
      config.redis,
      { connectionName: 'it-worker', forBullMQ: true },
      logger,
    );
  });

  afterAll(async () => {
    await closeRedisClient(client);
    await closeRedisClient(workerConnection);
  });

  it('connects and pings', async () => {
    expect(await client.ping()).toBe('PONG');
  });

  it('processes a job end-to-end and closes the worker gracefully', async () => {
    const queueName = 'it-echo';
    const queue = createQueue<{ value: number }>(queueName, client, settings);
    const events = new QueueEvents(queueName, {
      connection: config.redis,
      prefix: settings.prefix,
    });
    await events.waitUntilReady();

    const worker = createWorker<{ value: number }, number>(
      { queueName, processor: (job) => Promise.resolve(job.data.value * 2) },
      workerConnection,
      settings,
      logger,
    );

    try {
      const job = await queue.add('double', { value: 21 });
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toBe(42);
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
    expect(worker.isRunning()).toBe(false);
  });
});
