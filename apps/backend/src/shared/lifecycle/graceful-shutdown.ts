import type { Logger } from '../logger/logger.js';

export interface ShutdownTask {
  /** Human-readable resource name, used in logs. */
  readonly name: string;
  readonly close: () => Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly logger: Logger;
  /** Closed sequentially, in the given order (e.g. HTTP server → workers → Redis → MySQL). */
  readonly tasks: readonly ShutdownTask[];
  /** Hard deadline; after it the process exits with code 1 even if tasks are still pending. */
  readonly timeoutMs: number;
  /** Injected for tests. Defaults to process.exit. */
  readonly exit?: (code: number) => void;
}

export type ShutdownFn = (reason: string, exitCode?: number) => Promise<void>;

/**
 * Creates an idempotent shutdown function. Calling it more than once (e.g. a
 * SIGTERM followed by an uncaught exception) returns the in-flight shutdown
 * instead of starting another.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): ShutdownFn {
  const { logger, tasks, timeoutMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let inFlight: Promise<void> | undefined;

  return (reason, exitCode = 0) => {
    if (inFlight !== undefined) return inFlight;

    inFlight = (async () => {
      logger.info({ reason, timeoutMs }, 'Graceful shutdown started');
      const timer = setTimeout(() => {
        logger.fatal({ timeoutMs }, 'Graceful shutdown timed out; forcing exit');
        exit(1);
      }, timeoutMs);
      timer.unref();

      let finalCode = exitCode;
      for (const task of tasks) {
        try {
          await task.close();
          logger.info({ resource: task.name }, 'Resource closed');
        } catch (err) {
          finalCode = 1;
          logger.error({ err, resource: task.name }, 'Failed to close resource');
        }
      }

      clearTimeout(timer);
      logger.info({ exitCode: finalCode }, 'Graceful shutdown complete');
      exit(finalCode);
    })();

    return inFlight;
  };
}

/**
 * Wires the shutdown function to OS signals and fatal process events.
 * Unhandled rejections / uncaught exceptions leave the process in an unknown
 * state, so they trigger a shutdown with a non-zero exit code.
 */
export function bindProcessShutdown(shutdown: ShutdownFn, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });
}
