import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface LoggerSettings {
  readonly level: LoggerOptions['level'];
  readonly pretty: boolean;
  readonly service: string;
}

/**
 * Paths whose values must never appear in logs. Extend this list when new
 * sensitive fields are introduced (tokens, national IDs, medical data, ...).
 */
export const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.otpCode',
  '*.recoveryCode',
  '*.recoveryCodes',
  '*.privateKey',
  'req.headers["x-refresh-token"]',
  // Task 05/05.1 guest secrets
  'req.headers["x-guest-token"]',
  '*.guestToken',
  '*.claimCode',
];

/**
 * Creates the root structured (JSON) logger. Pretty printing is a development
 * convenience only and must stay disabled in production.
 */
export function createLogger(settings: LoggerSettings): Logger {
  return pino({
    level: settings.level ?? 'info',
    base: { service: settings.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(settings.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  });
}
