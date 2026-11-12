import { generateKeyPairSync, randomBytes } from 'node:crypto';

let cached: Record<string, string> | undefined;

/** Freshly generated (per test process) auth secrets as env vars. Never real secrets. */
export function testAuthEnv(): Record<string, string> {
  if (cached !== undefined) return cached;
  const { privateKey } = generateKeyPairSync('ed25519');
  cached = {
    AUTH_SECRET: randomBytes(48).toString('base64url'),
    AUTH_ACCESS_TOKEN_PRIVATE_KEY: Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ).toString('base64'),
    AUTH_ACCESS_TOKEN_KEY_ID: 'test-key-1',
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    OTP_PROVIDER: 'mock',
  };
  return cached;
}
