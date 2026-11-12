import type { Redis } from '../../infrastructure/redis/redis.js';

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the caller may try again (0 when allowed). */
  readonly retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiting and cooldowns. Backed by Redis in all environments so limits are
 * shared across API instances. Failures propagate (fail closed): if Redis is down, rate-limited
 * operations such as OTP requests are refused rather than left unprotected.
 */
export interface RateLimiter {
  /** Counts one hit against `key`; denies once more than `limit` hits occur in the window. */
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Succeeds at most once per `seconds` for `key` (e.g. OTP resend cooldown). */
  acquireCooldown(key: string, seconds: number): Promise<RateLimitResult>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const fullKey = `${this.prefix}:rl:${key}`;
    const results = await this.redis
      .multi()
      .incr(fullKey)
      .expire(fullKey, windowSeconds, 'NX')
      .ttl(fullKey)
      .exec();
    if (results === null) throw new Error('Rate limiter transaction aborted');
    for (const [err] of results) if (err !== null) throw err;
    const count = Number(results[0]?.[1]);
    const ttl = Number(results[2]?.[1]);
    if (count > limit) {
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  async acquireCooldown(key: string, seconds: number): Promise<RateLimitResult> {
    const fullKey = `${this.prefix}:cd:${key}`;
    const set = await this.redis.set(fullKey, '1', 'EX', seconds, 'NX');
    if (set === 'OK') return { allowed: true, retryAfterSeconds: 0 };
    const ttl = await this.redis.ttl(fullKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : seconds };
  }
}
