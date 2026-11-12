/**
 * Health service: aggregates dependency checks. Knows nothing about HTTP.
 */

export interface DependencyCheck {
  readonly name: string;
  /** Resolves when the dependency is reachable; rejects otherwise. */
  readonly check: () => Promise<void>;
}

export type DependencyState = 'up' | 'down';

export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly timestamp: string;
}

export interface ReadinessReport {
  readonly status: 'ready' | 'not_ready';
  readonly checks: Readonly<Record<string, DependencyState>>;
  readonly timestamp: string;
}

export interface HealthServiceOptions {
  readonly checks: readonly DependencyCheck[];
  readonly timeoutMs: number;
  /** Returns true once graceful shutdown has begun, so load balancers stop routing traffic. */
  readonly isShuttingDown: () => boolean;
  readonly now?: () => Date;
}

export class HealthService {
  private readonly now: () => Date;

  constructor(private readonly options: HealthServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  liveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: this.now().toISOString(),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      this.options.checks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), this.options.timeoutMs);
          return [name, 'up'] as const;
        } catch {
          return [name, 'down'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const allUp = results.every(([, state]) => state === 'up');
    return {
      status: allUp && !this.options.isShuttingDown() ? 'ready' : 'not_ready',
      checks,
      timestamp: this.now().toISOString(),
    };
  }
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
