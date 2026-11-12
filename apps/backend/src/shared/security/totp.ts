import { createHmac } from 'node:crypto';

/**
 * TOTP (RFC 6238) with HMAC-SHA1, 6 digits, 30-second steps: the parameters every common
 * authenticator app supports.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function totpStep(at: Date, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / stepSeconds);
}

/** HOTP (RFC 4226) value for a counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: Buffer, at: Date, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(at), digits);
}

/**
 * Verifies a code within ±`window` steps (clock drift). Returns the matched step so callers can
 * reject replays (a step must be strictly greater than the last accepted one), or undefined.
 */
export function verifyTotp(secret: Buffer, code: string, at: Date, window = 1): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = totpStep(at);
  let matched: number | undefined;
  // Check every candidate (no early exit) to keep timing independent of which step matched.
  for (let step = current - window; step <= current + window; step++) {
    if (hotp(secret, step) === code && matched === undefined) matched = step;
  }
  return matched;
}

export function totpUri(params: { issuer: string; account: string; secretBase32: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
