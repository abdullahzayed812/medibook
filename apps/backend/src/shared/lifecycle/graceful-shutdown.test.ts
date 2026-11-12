import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../test-support/silent-logger.js';
import { createGracefulShutdown } from './graceful-shutdown.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createGracefulShutdown', () => {
  it('closes tasks sequentially in order and exits with 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      logger: silentLogger(),
      timeoutMs: 1_000,
      exit,
      tasks: [
        { name: 'a', close: () => Promise.resolve(void order.push('a')) },
        { name: 'b', close: () => Promise.resolve(void order.push('b')) },
      ],
    });
    await shutdown('SIGTERM');
    expect(order).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('continues after a failing task and exits with 1', async () => {
    const exit = vi.fn();
    const closeB = vi.fn(() => Promise.resolve());
    const shutdown = createGracefulShutdown({
      logger: silentLogger(),
      timeoutMs: 1_000,
      exit,
      tasks: [
        { name: 'a', close: () => Promise.reject(new Error('boom')) },
        { name: 'b', close: closeB },
      ],
    });
    await shutdown('SIGTERM');
    expect(closeB).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('is idempotent', async () => {
    const exit = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    const shutdown = createGracefulShutdown({
      logger: silentLogger(),
      timeoutMs: 1_000,
      exit,
      tasks: [{ name: 'a', close }],
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-zero requested exit code', async () => {
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      logger: silentLogger(),
      timeoutMs: 1_000,
      exit,
      tasks: [],
    });
    await shutdown('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit(1) when tasks exceed the timeout', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      logger: silentLogger(),
      timeoutMs: 1_000,
      exit,
      tasks: [{ name: 'hangs', close: () => new Promise<void>(() => undefined) }],
    });
    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
