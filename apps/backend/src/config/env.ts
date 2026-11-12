import { z } from 'zod';

/**
 * Environment configuration schema.
 *
 * All configuration is read from environment variables exactly once, at startup,
 * and validated here. The process refuses to start with invalid configuration
 * (fail fast) instead of failing later at first use.
 */

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

const port = z.coerce.number().int().min(1).max(65535);
const seconds = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
/** OTP providers that only simulate delivery; never allowed when NODE_ENV=production. */
const DEV_ONLY_OTP_PROVIDERS: readonly string[] = ['mock'];
/** Private storage providers for development/tests only; never allowed when NODE_ENV=production. */
const DEV_ONLY_STORAGE_PROVIDERS: readonly string[] = ['local'];

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

const nodeEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const databaseEnvSchema = z.object({
  // MySQL (no defaults for credentials: they must be supplied explicitly)
  DB_HOST: z.string().min(1),
  DB_PORT: port.default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'must be a valid MySQL identifier'),
  DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(500).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});

const logEnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanString.default(false),
});

const envSchema = nodeEnvSchema
  .extend(databaseEnvSchema.shape)
  .extend(logEnvSchema.shape)
  .extend({
    // HTTP
    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    HTTP_PORT: port.default(3000),
    HTTP_BODY_LIMIT: z.string().min(1).default('1mb'),
    /**
     * Express "trust proxy" setting. Determines how `req.ip` (used for rate limiting and
     * security events) is derived. `false` = use the socket address. Use a hop count or
     * subnet list behind a known proxy; never `true` on an internet-facing instance.
     */
    HTTP_TRUST_PROXY: z.string().min(1).default('false'),

    // Redis
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port.default(6379),
    REDIS_PASSWORD: z.string().min(1).optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),

    // BullMQ / Redis key prefix
    QUEUE_PREFIX: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .default('medibook'),

    // Lifecycle
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),

    // --- Authentication ---
    /** Master secret for HMAC-based derived keys (OTP hashes, recovery-code hashes, subject hashes). */
    AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    /** Base64-encoded PKCS#8 PEM Ed25519 private key used to sign access tokens. */
    AUTH_ACCESS_TOKEN_PRIVATE_KEY: base64,
    AUTH_ACCESS_TOKEN_KEY_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    /** Optional previous public key (base64 SPKI PEM) still accepted during key rotation. */
    AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY: base64.optional(),
    AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    AUTH_ISSUER: z.string().min(1).default('medibook'),
    AUTH_AUDIENCE: z.string().min(1).default('medibook-api'),
    AUTH_ACCESS_TOKEN_TTL_SECONDS: seconds(60, 3_600).default(900),
    AUTH_REFRESH_TOKEN_TTL_SECONDS: seconds(3_600, 90 * 86_400).default(30 * 86_400),
    AUTH_SESSION_MAX_LIFETIME_SECONDS: seconds(3_600, 365 * 86_400).default(90 * 86_400),

    // --- OTP ---
    /** Only "mock" exists today; it is rejected in production (see refinement below). */
    OTP_PROVIDER: z.enum(['mock']),
    OTP_TTL_SECONDS: seconds(60, 900).default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    OTP_RESEND_COOLDOWN_SECONDS: seconds(10, 600).default(60),
    OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR: z.coerce.number().int().min(1).max(50).default(5),
    OTP_MAX_REQUESTS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(30),
    OTP_MAX_VERIFICATIONS_PER_IP_PER_15_MIN: z.coerce.number().int().min(1).max(10_000).default(30),
    /** ISO 3166-1 alpha-2 region used to parse numbers without a "+" prefix. Unset = E.164 only. */
    PHONE_DEFAULT_REGION: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),

    // --- Two-factor authentication ---
    /** Base64-encoded 32-byte key (AES-256-GCM) encrypting TOTP secrets at rest. */
    MFA_ENCRYPTION_KEY: base64,
    MFA_TOTP_ISSUER: z.string().min(1).max(64).default('MediBook'),
    MFA_MAX_VERIFICATIONS_PER_15_MIN: z.coerce.number().int().min(1).max(100).default(5),

    // --- Private document storage ---
    /** Only "local" (dev/test disk) exists until the R2 integration; rejected in production. */
    PRIVATE_STORAGE_PROVIDER: z.enum(['local']).default('local'),
    PRIVATE_STORAGE_LOCAL_DIR: z.string().min(1).default('.private-storage'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && DEV_ONLY_OTP_PROVIDERS.includes(env.OTP_PROVIDER)) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_PROVIDER'],
        message: 'the mock OTP provider is not allowed in production',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      DEV_ONLY_STORAGE_PROVIDERS.includes(env.PRIVATE_STORAGE_PROVIDER)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PRIVATE_STORAGE_PROVIDER'],
        message: 'local private storage is not allowed in production',
      });
    }
    if (Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64').length !== 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'must decode to exactly 32 bytes',
      });
    }
    const hasPrevKey = env.AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY !== undefined;
    const hasPrevKid = env.AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID !== undefined;
    if (hasPrevKey !== hasPrevKid) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID'],
        message: 'previous public key and key id must be set together',
      });
    }
    if (hasPrevKid && env.AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID === env.AUTH_ACCESS_TOKEN_KEY_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID'],
        message: 'must differ from AUTH_ACCESS_TOKEN_KEY_ID',
      });
    }
    if (env.AUTH_REFRESH_TOKEN_TTL_SECONDS > env.AUTH_SESSION_MAX_LIFETIME_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_REFRESH_TOKEN_TTL_SECONDS'],
        message: 'must not exceed AUTH_SESSION_MAX_LIFETIME_SECONDS',
      });
    }
  });

type Env = z.infer<typeof envSchema>;

export type TrustProxySetting = boolean | number | string;

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly connectionLimit: number;
  readonly connectTimeoutMs: number;
}

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly bodyLimit: string;
    readonly trustProxy: TrustProxySetting;
  };
  readonly log: {
    readonly level: Env['LOG_LEVEL'];
    readonly pretty: boolean;
  };
  readonly database: DatabaseConfig;
  readonly redis: {
    readonly host: string;
    readonly port: number;
    readonly password: string | undefined;
    readonly db: number;
  };
  readonly queue: {
    readonly prefix: string;
  };
  readonly lifecycle: {
    readonly shutdownTimeoutMs: number;
    readonly healthCheckTimeoutMs: number;
  };
  readonly auth: {
    readonly secret: string;
    readonly accessToken: {
      readonly privateKeyPem: string;
      readonly keyId: string;
      readonly previousPublicKeyPem: string | undefined;
      readonly previousKeyId: string | undefined;
      readonly issuer: string;
      readonly audience: string;
      readonly ttlSeconds: number;
    };
    readonly refreshTokenTtlSeconds: number;
    readonly sessionMaxLifetimeSeconds: number;
  };
  readonly otp: {
    readonly provider: Env['OTP_PROVIDER'];
    readonly ttlSeconds: number;
    readonly maxAttempts: number;
    readonly resendCooldownSeconds: number;
    readonly maxRequestsPerPhonePerHour: number;
    readonly maxRequestsPerIpPerHour: number;
    readonly maxVerificationsPerIpPer15Min: number;
    readonly phoneDefaultRegion: string | undefined;
  };
  readonly storage: {
    readonly provider: Env['PRIVATE_STORAGE_PROVIDER'];
    readonly localDir: string;
  };
  readonly mfa: {
    readonly encryptionKey: Buffer;
    readonly totpIssuer: string;
    readonly maxVerificationsPer15Min: number;
  };
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Treat empty strings as "not set" so `FOO=` falls back to the default (or fails if required). */
function normalize(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
}

/** Error messages name the offending variables but never echo their values. */
function parseOrThrow<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(normalize(source));
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

function decodePem(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseTrustProxy(value: string): TrustProxySetting {
  if (value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function toDatabaseConfig(env: z.infer<typeof databaseEnvSchema>): DatabaseConfig {
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
  };
}

/**
 * Loads only what the migration CLI needs, so migrations can run without API secrets.
 */
export function loadDatabaseConfig(source: NodeJS.ProcessEnv = process.env): {
  database: DatabaseConfig;
  log: AppConfig['log'];
} {
  const env = parseOrThrow(databaseEnvSchema.extend(logEnvSchema.shape), source);
  return deepFreeze({
    database: toDatabaseConfig(env),
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
  });
}

/** Validates the full environment and returns an immutable, typed config. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = parseOrThrow(envSchema, source);
  return deepFreeze({
    env: env.NODE_ENV,
    http: {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
      bodyLimit: env.HTTP_BODY_LIMIT,
      trustProxy: parseTrustProxy(env.HTTP_TRUST_PROXY),
    },
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    database: toDatabaseConfig(env),
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
    },
    queue: { prefix: env.QUEUE_PREFIX },
    lifecycle: {
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    },
    auth: {
      secret: env.AUTH_SECRET,
      accessToken: {
        privateKeyPem: decodePem(env.AUTH_ACCESS_TOKEN_PRIVATE_KEY),
        keyId: env.AUTH_ACCESS_TOKEN_KEY_ID,
        previousPublicKeyPem:
          env.AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY === undefined
            ? undefined
            : decodePem(env.AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY),
        previousKeyId: env.AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID,
        issuer: env.AUTH_ISSUER,
        audience: env.AUTH_AUDIENCE,
        ttlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      },
      refreshTokenTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      sessionMaxLifetimeSeconds: env.AUTH_SESSION_MAX_LIFETIME_SECONDS,
    },
    otp: {
      provider: env.OTP_PROVIDER,
      ttlSeconds: env.OTP_TTL_SECONDS,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      maxRequestsPerPhonePerHour: env.OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR,
      maxRequestsPerIpPerHour: env.OTP_MAX_REQUESTS_PER_IP_PER_HOUR,
      maxVerificationsPerIpPer15Min: env.OTP_MAX_VERIFICATIONS_PER_IP_PER_15_MIN,
      phoneDefaultRegion: env.PHONE_DEFAULT_REGION,
    },
    storage: { provider: env.PRIVATE_STORAGE_PROVIDER, localDir: env.PRIVATE_STORAGE_LOCAL_DIR },
    mfa: {
      encryptionKey: Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64'),
      totpIssuer: env.MFA_TOTP_ISSUER,
      maxVerificationsPer15Min: env.MFA_MAX_VERIFICATIONS_PER_15_MIN,
    },
  });
}

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    // Buffers cannot be frozen (typed arrays); they are kept private to the config object.
    if (child !== null && typeof child === 'object' && !Buffer.isBuffer(child)) {
      deepFreeze(child as object);
    }
  }
  return Object.freeze(value);
}
