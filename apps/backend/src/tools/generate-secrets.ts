import { generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Prints freshly generated auth secrets as .env lines (development/bootstrap only).
 * Production secrets belong in a secrets manager; never commit the output.
 */
const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyId = `k-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;

process.stdout.write(
  [
    `AUTH_SECRET=${randomBytes(48).toString('base64url')}`,
    `AUTH_ACCESS_TOKEN_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`,
    `AUTH_ACCESS_TOKEN_KEY_ID=${keyId}`,
    `MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
    '',
  ].join('\n'),
);
