import { Queue, Worker, type JobsOptions, type Processor, type WorkerOptions } from 'bullmq';
import type { Redis } from '../redis/redis.js';
import type { Logger } from '../../shared/logger/logger.js';

/**
 * BullMQ infrastructure. Queues carry work, not truth: every job that matters must be
 * derivable from (or reconciled against) MySQL, the system of record. Jobs must be
 * idempotent because BullMQ delivers at-least-once.
 */

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

export interface QueueSettings {
  /** Key prefix isolating this application's queues inside Redis. */
  readonly prefix: string;
}

/**
 * Producer side. `connection` may be a regular client; BullMQ duplicates it as needed.
 */
export function createQueue<TData = unknown>(
  name: string,
  connection: Redis,
  settings: QueueSettings,
): Queue<TData> {
  return new Queue<TData>(name, {
    connection,
    prefix: settings.prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Describes one queue consumer. Business modules will export definitions and register them
 * in `src/jobs/registry.ts`; the worker process starts one BullMQ Worker per definition.
 */
export interface JobDefinition<TData = unknown, TResult = unknown> {
  readonly queueName: string;
  readonly processor: Processor<TData, TResult>;
  readonly concurrency?: number;
}

/**
 * Consumer side. `connection` MUST be created with `forBullMQ: true` (maxRetriesPerRequest: null).
 */
export function createWorker<TData, TResult>(
  definition: JobDefinition<TData, TResult>,
  connection: Redis,
  settings: QueueSettings,
  logger: Logger,
  overrides: Partial<WorkerOptions> = {},
): Worker<TData, TResult> {
  const worker = new Worker<TData, TResult>(definition.queueName, definition.processor, {
    connection,
    prefix: settings.prefix,
    concurrency: definition.concurrency ?? 1,
    ...overrides,
  });
  const log = logger.child({ queue: definition.queueName });
  worker.on('failed', (job, err) => {
    log.error({ err, jobId: job?.id, attemptsMade: job?.attemptsMade }, 'Job failed');
  });
  worker.on('error', (err) => {
    log.error({ err }, 'Worker error');
  });
  return worker;
}
