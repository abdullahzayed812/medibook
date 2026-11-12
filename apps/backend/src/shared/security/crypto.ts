import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Small, dependency-free cryptographic helpers. Everything security-relevant in the identity
 * modules goes through these functions so the primitives are reviewed in one place.
 */

/** Cryptographically secure random token, base64url encoded (`bytes` of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests (false when lengths differ). */
export function hexDigestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * Derives an independent 32-byte key per purpose from the master secret (HKDF-SHA256), so one
 * configured secret never doubles as the key for two different uses.
 */
export function deriveKey(masterSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterSecret, 'medibook', `medibook:${purpose}`, 32));
}

const AES_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM. Output layout: version(1) | iv(12) | tag(16) | ciphertext. */
export function encrypt(key: Buffer, plaintext: Buffer, associatedData: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([AES_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the payload was tampered with, the AAD differs, or the key is wrong. */
export function decrypt(key: Buffer, payload: Buffer, associatedData: string): Buffer {
  if (payload.length < 1 + IV_BYTES + TAG_BYTES || payload[0] !== AES_VERSION) {
    throw new Error('Unsupported ciphertext format');
  }
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
