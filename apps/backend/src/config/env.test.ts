import { describe, expect, it } from 'vitest';
import { testAuthEnv } from '../test-support/auth-env.js';
import { ConfigValidationError, loadConfig, loadDatabaseConfig } from './env.js';

const validEnv = {
  DB_HOST: 'localhost',
  DB_USER: 'app',
  DB_PASSWORD: 'not-a-real-secret',
  DB_NAME: 'medibook_test',
  REDIS_HOST: 'localhost',
  ...testAuthEnv(),
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(validEnv);
    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.database.port).toBe(3306);
    expect(config.database.connectionLimit).toBe(10);
    expect(config.redis.port).toBe(6379);
    expect(config.redis.password).toBeUndefined();
    expect(config.log.pretty).toBe(false);
  });

  it('coerces numeric and boolean strings', () => {
    const config = loadConfig({
      ...validEnv,
      HTTP_PORT: '8080',
      LOG_PRETTY: 'true',
      REDIS_DB: '2',
    });
    expect(config.http.port).toBe(8080);
    expect(config.log.pretty).toBe(true);
    expect(config.redis.db).toBe(2);
  });

  it('returns a deeply frozen object', () => {
    const config = loadConfig(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('rejects missing required variables and names them', () => {
    expect(() => loadConfig({})).toThrow(ConfigValidationError);
    try {
      loadConfig({});
    } catch (err) {
      const message = (err as ConfigValidationError).message;
      for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_HOST']) {
        expect(message).toContain(key);
      }
    }
  });

  it('treats empty strings as unset', () => {
    expect(() => loadConfig({ ...validEnv, DB_PASSWORD: '' })).toThrow(/DB_PASSWORD/);
    expect(loadConfig({ ...validEnv, HTTP_PORT: '' }).http.port).toBe(3000);
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ...validEnv, HTTP_PORT: '70000' })).toThrow(/HTTP_PORT/);
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadConfig({ ...validEnv, LOG_PRETTY: 'yes' })).toThrow(/LOG_PRETTY/);
    expect(() => loadConfig({ ...validEnv, DB_NAME: 'bad-name;' })).toThrow(/DB_NAME/);
  });

  it('never includes secret values in error messages', () => {
    const secret = 'super-secret-value-123';
    try {
      loadConfig({ ...validEnv, DB_PASSWORD: secret, HTTP_PORT: 'not-a-port' });
      expect.fail('expected validation error');
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('rejects the mock OTP provider in production', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production' })).toThrow(/OTP_PROVIDER/);
    expect(loadConfig({ ...validEnv, NODE_ENV: 'development' }).otp.provider).toBe('mock');
  });

  it('requires auth secrets and validates their shape', () => {
    const { AUTH_SECRET: _secret, ...withoutSecret } = validEnv as Record<string, string>;
    expect(() => loadConfig(withoutSecret)).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ ...validEnv, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
    expect(() =>
      loadConfig({ ...validEnv, MFA_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/MFA_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...validEnv, AUTH_ACCESS_TOKEN_PREVIOUS_KEY_ID: 'old' })).toThrow(
      /PREVIOUS_KEY_ID/,
    );
  });

  it('decodes the signing key and never accepts a refresh TTL above the session lifetime', () => {
    expect(loadConfig(validEnv).auth.accessToken.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(() =>
      loadConfig({
        ...validEnv,
        AUTH_REFRESH_TOKEN_TTL_SECONDS: '864000',
        AUTH_SESSION_MAX_LIFETIME_SECONDS: '86400',
      }),
    ).toThrow(/AUTH_REFRESH_TOKEN_TTL_SECONDS/);
  });

  it('loads database-only configuration without auth secrets (migration CLI)', () => {
    const config = loadDatabaseConfig({
      DB_HOST: 'h',
      DB_USER: 'u',
      DB_PASSWORD: 'p',
      DB_NAME: 'medibook',
    });
    expect(config.database.host).toBe('h');
  });

  it('parses trust proxy settings', () => {
    expect(loadConfig(validEnv).http.trustProxy).toBe(false);
    expect(loadConfig({ ...validEnv, HTTP_TRUST_PROXY: '1' }).http.trustProxy).toBe(1);
    expect(loadConfig({ ...validEnv, HTTP_TRUST_PROXY: 'loopback' }).http.trustProxy).toBe(
      'loopback',
    );
  });
});
