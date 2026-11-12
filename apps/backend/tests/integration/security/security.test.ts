import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import {
  addMembership,
  body,
  createClinic,
  createUser,
  grantGlobalRole,
  login,
  testDevice,
  testPhone,
} from '../support/fixtures.js';
import { codeAt, enrollMfa } from '../support/mfa.js';

const h = createHarness({
  env: {
    OTP_MAX_ATTEMPTS: '5',
    OTP_MAX_VERIFICATIONS_PER_IP_PER_15_MIN: '8',
    MFA_MAX_VERIFICATIONS_PER_15_MIN: '4',
  },
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const me = (authorization: string) =>
  h.http().get('/api/v1/me').set('Authorization', authorization);
const errorCode = (res: { body: unknown }) => body<{ error: { code: string } }>(res).error.code;

describe('access token attacks', () => {
  it('rejects a token whose payload was tampered with (privilege/identity swap)', async () => {
    const victim = await login(h, testPhone());
    const attacker = await login(h, testPhone());
    const [header, payload, signature] = attacker.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: victim.userId, sid: victim.sessionId }),
    ).toString('base64url');
    const res = await me(`Bearer ${header}.${forged}.${signature}`);
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('INVALID_TOKEN');
  });

  it('rejects a well-formed token signed with an attacker key', async () => {
    const s = await login(h, testPhone());
    const { privateKey } = generateKeyPairSync('ed25519');
    const kid = (
      JSON.parse(Buffer.from(s.accessToken.split('.')[0]!, 'base64url').toString()) as {
        kid: string;
      }
    ).kid;
    const forged = await new SignJWT({ sid: s.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
      .setSubject(s.userId)
      .setIssuer('medibook')
      .setAudience('medibook-api')
      .setIssuedAt()
      .setJti('forged')
      .setExpirationTime('10m')
      .sign(privateKey);
    expect(errorCode(await me(`Bearer ${forged}`))).toBe('INVALID_TOKEN');
  });

  it('rejects an expired access token (and refresh still works)', async () => {
    const s = await login(h, testPhone());
    h.clock.advance(16 * 60_000);
    expect(errorCode(await me(s.bearer))).toBe('TOKEN_EXPIRED');
    const refreshed = await h
      .http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(refreshed.status).toBe(200);
  });

  it('rejects missing, malformed and non-Bearer credentials', async () => {
    expect((await h.http().get('/api/v1/me')).status).toBe(401);
    expect((await me('Basic dXNlcjpwYXNz')).status).toBe(401);
    expect((await me('Bearer not-a-jwt')).status).toBe(401);
    expect((await me('Bearer ')).status).toBe(401);
  });

  it('a valid token for a session of another user cannot be combined with that session', async () => {
    // Defence in depth: the session row must belong to the token subject.
    const a = await login(h, testPhone());
    const b = await login(h, testPhone());
    await h.db.execute('UPDATE sessions SET user_id = ? WHERE id = ?', [b.userId, a.sessionId]);
    expect(errorCode(await me(a.bearer))).toBe('SESSION_INVALID');
  });
});

describe('refresh token replay', () => {
  it('a replayed refresh token kills the session for both attacker and victim', async () => {
    const s = await login(h, testPhone());
    const first = await h
      .http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    const victimPair = body<{ data: { accessToken: string; refreshToken: string } }>(first).data;
    const attackerReplay = await h
      .http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s.refreshToken });
    expect(attackerReplay.status).toBe(401);
    expect(
      (await h.http().post('/api/v1/auth/refresh').send({ refreshToken: victimPair.refreshToken }))
        .status,
    ).toBe(401);
    expect((await me(`Bearer ${victimPair.accessToken}`)).status).toBe(401);
  });

  it('a refresh token cannot be used after logout', async () => {
    const s = await login(h, testPhone());
    await h.http().post('/api/v1/auth/logout').set('Authorization', s.bearer);
    expect(
      (await h.http().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken })).status,
    ).toBe(401);
  });
});

describe('OTP brute force', () => {
  it('cannot brute-force a code: the challenge locks after the attempt limit', async () => {
    const phone = testPhone();
    const res = await h.http().post('/api/v1/auth/otp/request').send({ phone });
    const { challengeId } = body<{ data: { challengeId: string } }>(res).data;
    const real = h.otp.lastCodeFor(phone)!;
    const guesses = ['000000', '111111', '222222', '333333', '444444', '555555'].filter(
      (g) => g !== real,
    );
    const results = await Promise.all(
      guesses.map((code, i) =>
        h
          .http()
          .post('/api/v1/auth/otp/verify')
          .set('X-Forwarded-For', `198.18.0.${i}`)
          .send({ challengeId, phone, code, device: testDevice() }),
      ),
    );
    expect(results.every((r) => r.status === 400)).toBe(true);
    const [row] = await h.db.query<{ attempt_count: number; status: string }>(
      'SELECT attempt_count, status FROM otp_challenges WHERE id = ?',
      [challengeId],
    );
    // Parallel guesses are serialized by the row lock: never more than max_attempts counted.
    expect(row?.attempt_count).toBe(5);
    expect(row?.status).toBe('LOCKED');
    const withReal = await h
      .http()
      .post('/api/v1/auth/otp/verify')
      .send({ challengeId, phone, code: real, device: testDevice() });
    expect(errorCode(withReal)).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('throttles verification attempts per IP across challenges', async () => {
    const ip = '198.19.0.1';
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const res = await h
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({
          challengeId: 'f'.repeat(32),
          phone: '+12025550100',
          code: '123456',
          device: testDevice(),
        });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('privilege escalation', () => {
  it('non-admins cannot call platform admin endpoints', async () => {
    const owner = await createUser(h.db);
    const clinic = await createClinic(h.db);
    await addMembership(h.db, { clinicId: clinic, userId: owner.id, role: 'CLINIC_OWNER' });
    const s = await login(h, owner.phone);
    const target = await createUser(h.db);
    const res = await h
      .http()
      .post(`/api/v1/admin/users/${target.id}/suspend`)
      .set('Authorization', s.bearer)
      .set('X-Clinic-Id', clinic)
      .send({ reason: 'escalation attempt' });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
    const [row] = await h.db.query<{ status: string }>('SELECT status FROM users WHERE id = ?', [
      target.id,
    ]);
    expect(row?.status).toBe('ACTIVE');
  });

  it('a super admin without a verified 2FA session cannot act, even with enrollment present', async () => {
    const adminUser = await createUser(h.db);
    await grantGlobalRole(h.db, adminUser.id, 'SUPER_ADMIN');
    const first = await login(h, adminUser.phone, { device: testDevice('ADMIN_WEB') });
    await enrollMfa(h, first);
    // New session (other device) → not MFA-verified yet.
    const second = await login(h, adminUser.phone, { device: testDevice('ADMIN_WEB') });
    const target = await createUser(h.db);
    const res = await h
      .http()
      .post(`/api/v1/admin/users/${target.id}/suspend`)
      .set('Authorization', second.bearer)
      .send({ reason: 'needs mfa' });
    expect(errorCode(res)).toBe('MFA_REQUIRED');
  });

  it('admins cannot suspend themselves', async () => {
    const adminUser = await createUser(h.db);
    await grantGlobalRole(h.db, adminUser.id, 'SUPER_ADMIN');
    const s = await login(h, adminUser.phone);
    await enrollMfa(h, s);
    const res = await h
      .http()
      .post(`/api/v1/admin/users/${adminUser.id}/suspend`)
      .set('Authorization', s.bearer)
      .send({ reason: 'self' });
    expect(res.status).toBe(403);
  });

  it('client-supplied role/permission fields have no effect', async () => {
    const s = await login(h, testPhone());
    const res = await h
      .http()
      .get('/api/v1/me/permissions')
      .set('Authorization', s.bearer)
      .set('X-Roles', 'SUPER_ADMIN')
      .query({ role: 'SUPER_ADMIN' });
    expect(
      body<{ data: { platform: { permissions: string[] } } }>(res).data.platform.permissions,
    ).toEqual([]);
  });
});

describe('session revocation on account suspension', () => {
  it('suspending an account (admin API) revokes all its sessions immediately and audits the change', async () => {
    const adminUser = await createUser(h.db);
    await grantGlobalRole(h.db, adminUser.id, 'SUPER_ADMIN');
    const admin = await login(h, adminUser.phone);
    await enrollMfa(h, admin);
    const victimUser = await createUser(h.db);
    const v1 = await login(h, victimUser.phone, { device: testDevice('PATIENT_MOBILE') });
    const v2 = await login(h, victimUser.phone, { device: testDevice('PATIENT_WEB') });

    const res = await h
      .http()
      .post(`/api/v1/admin/users/${victimUser.id}/suspend`)
      .set('Authorization', admin.bearer)
      .send({ reason: 'fraud investigation' });
    expect(res.status).toBe(204);
    expect((await me(v1.bearer)).status).toBe(401);
    expect((await me(v2.bearer)).status).toBe(401);
    expect(
      (await h.http().post('/api/v1/auth/refresh').send({ refreshToken: v1.refreshToken })).status,
    ).toBe(401);
    const audit = await h.db.query<{ action: string; actor_user_id: string }>(
      'SELECT action, actor_user_id FROM audit_events WHERE target_id = ?',
      [victimUser.id],
    );
    expect(audit).toEqual([{ action: 'ACCOUNT_SUSPENDED', actor_user_id: adminUser.id }]);

    const reactivate = await h
      .http()
      .post(`/api/v1/admin/users/${victimUser.id}/reactivate`)
      .set('Authorization', admin.bearer)
      .send({ reason: 'cleared' });
    expect(reactivate.status).toBe(204);
    expect((await me(v1.bearer)).status).toBe(401); // old sessions stay revoked
    expect((await login(h, victimUser.phone)).userId).toBe(victimUser.id);
  });
});

describe('two-factor authentication', () => {
  it('enrollment stores an encrypted secret, returns recovery codes once, and revokes other sessions', async () => {
    const phone = testPhone();
    const other = await login(h, phone, { device: testDevice('PATIENT_WEB') });
    const s = await login(h, phone, { device: testDevice('ADMIN_WEB') });
    const { secret, recoveryCodes } = await enrollMfa(h, s);
    expect(recoveryCodes).toHaveLength(10);
    const [cred] = await h.db.query<{ secret_ciphertext: Buffer; status: string }>(
      'SELECT secret_ciphertext, status FROM mfa_totp_credentials',
    );
    expect(cred?.status).toBe('ACTIVE');
    expect(cred?.secret_ciphertext.toString('latin1')).not.toContain(secret);
    const hashes = JSON.stringify(await h.db.query('SELECT code_hash FROM mfa_recovery_codes'));
    for (const code of recoveryCodes) expect(hashes).not.toContain(code.replace('-', ''));
    expect((await me(other.bearer)).status).toBe(401);
    expect(
      body<{ data: { mfa: { enrolled: boolean; verifiedForSession: boolean } } }>(
        await me(s.bearer),
      ).data.mfa,
    ).toMatchObject({ enrolled: true, verifiedForSession: true });
  });

  it('rejects wrong codes and replayed codes', async () => {
    const phone = testPhone();
    const s = await login(h, phone);
    const { secret } = await enrollMfa(h, s);
    const next = await login(h, phone);
    const verify = (code: string) =>
      h.http().post('/api/v1/security/mfa/verify').set('Authorization', next.bearer).send({ code });
    // A code outside the ±1-step acceptance window, so the assertion can never flake.
    const valid = new Set([-1, 0, 1].map((offset) => codeAt(secret, h.clock(), offset)));
    const wrong = ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c))!;
    expect(errorCode(await verify(wrong))).toBe('MFA_CODE_INVALID');
    const fresh = codeAt(secret, h.clock(), 1);
    expect((await verify(fresh)).status).toBe(204);
    const third = await login(h, phone);
    const replay = await h
      .http()
      .post('/api/v1/security/mfa/verify')
      .set('Authorization', third.bearer)
      .send({ code: fresh });
    expect(errorCode(replay)).toBe('MFA_CODE_INVALID');
  });

  it('accepts each recovery code exactly once', async () => {
    const phone = testPhone();
    const s = await login(h, phone);
    const { recoveryCodes } = await enrollMfa(h, s);
    const a = await login(h, phone);
    expect(
      (
        await h
          .http()
          .post('/api/v1/security/mfa/verify')
          .set('Authorization', a.bearer)
          .send({ recoveryCode: recoveryCodes[0] })
      ).status,
    ).toBe(204);
    const b = await login(h, phone);
    expect(
      errorCode(
        await h
          .http()
          .post('/api/v1/security/mfa/verify')
          .set('Authorization', b.bearer)
          .send({ recoveryCode: recoveryCodes[0] }),
      ),
    ).toBe('MFA_CODE_INVALID');
    expect(
      body<{ data: { mfa: { remainingRecoveryCodes: number } } }>(await me(a.bearer)).data.mfa
        .remainingRecoveryCodes,
    ).toBe(9);
  });

  it('rate limits 2FA verification attempts per user', async () => {
    const phone = testPhone();
    const s = await login(h, phone);
    await enrollMfa(h, s); // uses 1 of 4 attempts
    const n = await login(h, phone);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (
          await h
            .http()
            .post('/api/v1/security/mfa/verify')
            .set('Authorization', n.bearer)
            .send({ code: '000001' })
        ).status,
      );
    }
    expect(statuses.at(-1)).toBe(429);
  });

  it('refuses re-enrollment over an active credential and recovery-code regeneration without MFA', async () => {
    const phone = testPhone();
    const s = await login(h, phone);
    await enrollMfa(h, s);
    expect(
      (await h.http().post('/api/v1/security/mfa/totp/enrollment').set('Authorization', s.bearer))
        .status,
    ).toBe(409);
    const fresh = await login(h, phone);
    expect(
      errorCode(
        await h
          .http()
          .post('/api/v1/security/mfa/recovery-codes')
          .set('Authorization', fresh.bearer),
      ),
    ).toBe('MFA_REQUIRED');
    expect(
      (await h.http().post('/api/v1/security/mfa/recovery-codes').set('Authorization', s.bearer))
        .status,
    ).toBe(200);
  });
});

describe('no secrets in responses or security logs', () => {
  it('never exposes refresh-token hashes, OTP hashes or secrets via API, and never logs tokens in events', async () => {
    const s = await login(h, testPhone());
    for (const path of [
      '/api/v1/me',
      '/api/v1/sessions',
      '/api/v1/me/security-events',
      '/api/v1/me/memberships',
    ]) {
      const text = JSON.stringify((await h.http().get(path).set('Authorization', s.bearer)).body);
      expect(text).not.toContain(s.refreshToken);
      expect(text).not.toMatch(/token_hash|code_hash|secret/i);
    }
    const events = JSON.stringify(await h.db.query('SELECT * FROM security_events'));
    expect(events).not.toContain(s.refreshToken);
    expect(events).not.toContain(s.accessToken);
  });
});
