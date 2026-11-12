import { base32Decode } from '../../../src/shared/security/base32.js';
import { hotp, totpStep } from '../../../src/shared/security/totp.js';
import type { Harness } from './harness.js';
import { body, type LoggedIn } from './fixtures.js';

export function codeAt(secretBase32: string, at: Date, stepOffset = 0): string {
  return hotp(base32Decode(secretBase32), totpStep(at) + stepOffset);
}

/** Enrolls TOTP for the session's user via the API; returns the secret and recovery codes. */
export async function enrollMfa(
  h: Harness,
  s: LoggedIn,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const started = await h
    .http()
    .post('/api/v1/security/mfa/totp/enrollment')
    .set('Authorization', s.bearer);
  if (started.status !== 201) throw new Error(`enrollment failed ${started.status}`);
  const { secret } = body<{ data: { secret: string } }>(started).data;
  const confirmed = await h
    .http()
    .post('/api/v1/security/mfa/totp/enrollment/confirm')
    .set('Authorization', s.bearer)
    .send({ code: codeAt(secret, h.clock()) });
  if (confirmed.status !== 200)
    throw new Error(`confirm failed ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  return {
    secret,
    recoveryCodes: body<{ data: { recoveryCodes: string[] } }>(confirmed).data.recoveryCodes,
  };
}
