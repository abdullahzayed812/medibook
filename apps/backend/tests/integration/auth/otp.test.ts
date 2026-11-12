import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness } from '../support/harness.js';
import { body, createUser, login, testDevice, testPhone } from '../support/fixtures.js';

const h = createHarness({ env: { OTP_MAX_ATTEMPTS: '3', OTP_RESEND_COOLDOWN_SECONDS: '30' } });
afterAll(() => h.close());
beforeEach(() => h.reset());

const IP = '203.0.113.10';

async function requestOtp(phone: string, ip = IP) {
  return h.http().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone });
}

async function verify(challengeId: string, phone: string, code: string, ip = IP) {
  return h
    .http()
    .post('/api/v1/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ challengeId, phone, code, device: testDevice() });
}

function challengeOf(res: { body: unknown }): string {
  return body<{ data: { challengeId: string } }>(res).data.challengeId;
}

const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('OTP authentication', () => {
  // Regression (found in Task 05): parallel requests for different phones used to deadlock
  // (REPEATABLE READ gap locks between the superseding UPDATE and the INSERT) and return 500.
  it('serves concurrent code requests for different phones without errors', async () => {
    const phones = Array.from({ length: 8 }, () => testPhone());
    const res = await Promise.all(
      phones.map((phone, i) =>
        h
          .http()
          .post('/api/v1/auth/otp/request')
          .set('X-Forwarded-For', `10.9.0.${i + 1}`)
          .send({ phone }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(202));
  });

  // Regression (found in Task 05): concurrent FIRST logins of different users deadlocked.
  it('serves concurrent first logins of different users without errors', async () => {
    const phones = Array.from({ length: 6 }, () => testPhone());
    const sessions = await Promise.all(
      phones.map((phone) => login(h, phone, { device: testDevice('PATIENT_MOBILE') })),
    );
    expect(new Set(sessions.map((x) => x.userId)).size).toBe(6);
  });

  it('logs in with a valid OTP and creates the account on first verification', async () => {
    const phone = testPhone();
    const requested = await requestOtp(phone);
    expect(requested.status).toBe(202);
    const res = await verify(challengeOf(requested), phone, h.otp.lastCodeFor(phone)!);
    expect(res.status).toBe(200);
    const data = body<{
      data: {
        accessToken: string;
        refreshToken: string;
        account: { status: string; isNew: boolean };
        mfaRequired: boolean;
      };
    }>(res).data;
    expect(data.account).toMatchObject({ status: 'ACTIVE', isNew: true });
    expect(data.mfaRequired).toBe(false);
    expect(data.accessToken.split('.')).toHaveLength(3);

    const [user] = await h.db.query<{ id: string }>('SELECT id FROM users WHERE phone_e164 = ?', [
      phone,
    ]);
    const second = await login(h, phone);
    expect(second.userId).toBe(user?.id);
    expect(await h.db.query('SELECT id FROM users WHERE phone_e164 = ?', [phone])).toHaveLength(1);
  });

  it('normalizes phone formats so one person keeps one account', async () => {
    const a = await login(h, '+1 (202) 555-0177');
    const b = await login(h, '+12025550177');
    expect(a.userId).toBe(b.userId);
  });

  it('returns an identical response shape whether or not an account exists', async () => {
    const existing = await createUser(h.db);
    const fresh = testPhone();
    const r1 = await requestOtp(existing.phone);
    const r2 = await requestOtp(fresh, '203.0.113.11');
    expect(r1.status).toBe(r2.status);
    expect(Object.keys(body<{ data: object }>(r1).data).sort()).toEqual(
      Object.keys(body<{ data: object }>(r2).data).sort(),
    );
    expect(JSON.stringify(r1.body)).not.toMatch(/exist|account|user/i);
  });

  it('rejects an invalid OTP without revealing details and counts the attempt', async () => {
    const phone = testPhone();
    const challengeId = challengeOf(await requestOtp(phone));
    const res = await verify(challengeId, phone, wrongCode(h.otp.lastCodeFor(phone)!));
    expect(res.status).toBe(400);
    expect(body<{ error: { code: string } }>(res).error.code).toBe('OTP_INVALID');
    const [row] = await h.db.query<{ attempt_count: number; status: string }>(
      'SELECT attempt_count, status FROM otp_challenges WHERE id = ?',
      [challengeId],
    );
    expect(row).toMatchObject({ attempt_count: 1, status: 'PENDING' });
  });

  it('rejects an expired OTP', async () => {
    const phone = testPhone();
    const challengeId = challengeOf(await requestOtp(phone));
    h.clock.advance(301_000);
    const res = await verify(challengeId, phone, h.otp.lastCodeFor(phone)!);
    expect(body<{ error: { code: string } }>(res).error.code).toBe('OTP_INVALID');
    const [row] = await h.db.query<{ status: string }>(
      'SELECT status FROM otp_challenges WHERE id = ?',
      [challengeId],
    );
    expect(row?.status).toBe('EXPIRED');
  });

  it('rejects a reused OTP', async () => {
    const phone = testPhone();
    const challengeId = challengeOf(await requestOtp(phone));
    const code = h.otp.lastCodeFor(phone)!;
    expect((await verify(challengeId, phone, code)).status).toBe(200);
    const again = await verify(challengeId, phone, code);
    expect(again.status).toBe(400);
    expect(body<{ error: { code: string } }>(again).error.code).toBe('OTP_INVALID');
  });

  it('locks the challenge after the maximum number of attempts, even for the right code', async () => {
    const phone = testPhone();
    const challengeId = challengeOf(await requestOtp(phone));
    const code = h.otp.lastCodeFor(phone)!;
    expect((await verify(challengeId, phone, wrongCode(code))).status).toBe(400);
    expect((await verify(challengeId, phone, wrongCode(code))).status).toBe(400);
    const third = await verify(challengeId, phone, wrongCode(code));
    expect(body<{ error: { code: string } }>(third).error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    const correct = await verify(challengeId, phone, code);
    expect(body<{ error: { code: string } }>(correct).error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
    const events = await h.db.query<{ event_type: string }>(
      `SELECT event_type FROM security_events WHERE event_type = 'OTP_LOCKED'`,
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('does not accept a challenge for a different phone number', async () => {
    const phone = testPhone();
    const challengeId = challengeOf(await requestOtp(phone));
    const res = await verify(challengeId, testPhone(), h.otp.lastCodeFor(phone)!);
    expect(body<{ error: { code: string } }>(res).error.code).toBe('OTP_INVALID');
  });

  it('enforces the resend cooldown and supersedes older challenges', async () => {
    const phone = testPhone();
    const first = await requestOtp(phone);
    const firstCode = h.otp.lastCodeFor(phone)!;
    const tooSoon = await requestOtp(phone);
    expect(tooSoon.status).toBe(429);
    expect(body<{ error: { code: string } }>(tooSoon).error.code).toBe('OTP_RATE_LIMITED');
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.otp.sentCount(phone)).toBe(1);

    await h.redis.del(...(await h.redis.keys('*:cd:otp:req:phone:*')));
    const second = await requestOtp(phone);
    expect(second.status).toBe(202);
    const old = await verify(challengeOf(first), phone, firstCode);
    expect(old.status).toBe(400);
    const [row] = await h.db.query<{ status: string }>(
      'SELECT status FROM otp_challenges WHERE id = ?',
      [challengeOf(first)],
    );
    expect(row?.status).toBe('SUPERSEDED');
  });

  it('rate limits OTP requests per phone per hour', async () => {
    const phone = testPhone();
    for (let i = 0; i < 5; i++) {
      await h.redis.del(...(await h.redis.keys('*:cd:*')).concat('nonexistent'));
      expect((await requestOtp(phone, `198.51.100.${i}`)).status).toBe(202);
    }
    await h.redis.del(...(await h.redis.keys('*:cd:*')).concat('nonexistent'));
    expect((await requestOtp(phone, '198.51.100.99')).status).toBe(429);
  });

  it('rate limits OTP requests per IP across phones', async () => {
    const limited = createHarness({ env: { OTP_MAX_REQUESTS_PER_IP_PER_HOUR: '2' } });
    try {
      const send = (phone: string) =>
        limited
          .http()
          .post('/api/v1/auth/otp/request')
          .set('X-Forwarded-For', '192.0.2.50')
          .send({ phone });
      expect((await send(testPhone())).status).toBe(202);
      expect((await send(testPhone())).status).toBe(202);
      const third = await send(testPhone());
      expect(third.status).toBe(429);
      const events = await limited.db.query(
        `SELECT id FROM security_events WHERE event_type = 'OTP_REQUEST_RATE_LIMITED'`,
      );
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('stores only an HMAC of the code and never returns or records it', async () => {
    const phone = testPhone();
    const requested = await requestOtp(phone);
    const code = h.otp.lastCodeFor(phone)!;
    expect(JSON.stringify(requested.body)).not.toContain(code);
    const [row] = await h.db.query<{ code_hash: string }>(
      'SELECT code_hash FROM otp_challenges WHERE id = ?',
      [challengeOf(requested)],
    );
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(code);
    const events = await h.db.query<{ metadata: unknown }>('SELECT metadata FROM security_events');
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it('blocks login for suspended and inactive accounts after a correct OTP', async () => {
    for (const status of ['SUSPENDED', 'INACTIVE'] as const) {
      const user = await createUser(h.db, { status });
      const requested = await requestOtp(user.phone, `203.0.113.${status.length}`);
      const res = await verify(challengeOf(requested), user.phone, h.otp.lastCodeFor(user.phone)!);
      expect(res.status).toBe(403);
      expect(body<{ error: { code: string } }>(res).error.code).toBe(`ACCOUNT_${status}`);
      const sessions = await h.db.query('SELECT id FROM sessions WHERE user_id = ?', [user.id]);
      expect(sessions).toHaveLength(0);
    }
  });

  it('activates a PENDING_VERIFICATION account on first successful OTP', async () => {
    const user = await createUser(h.db, { status: 'PENDING_VERIFICATION' });
    const session = await login(h, user.phone);
    expect(session.userId).toBe(user.id);
    const [row] = await h.db.query<{ status: string; phone_verified_at: Date | null }>(
      'SELECT status, phone_verified_at FROM users WHERE id = ?',
      [user.id],
    );
    expect(row?.status).toBe('ACTIVE');
    expect(row?.phone_verified_at).not.toBeNull();
  });

  it('records login security events', async () => {
    const phone = testPhone();
    const session = await login(h, phone);
    const events = await h.db.query<{ event_type: string }>(
      'SELECT event_type FROM security_events WHERE user_id = ? ORDER BY id',
      [session.userId],
    );
    expect(events.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(['ACCOUNT_CREATED', 'OTP_VERIFICATION_SUCCEEDED', 'LOGIN_SUCCEEDED']),
    );
  });

  it('rejects malformed input with validation errors', async () => {
    expect(
      (await h.http().post('/api/v1/auth/otp/request').send({ phone: 'not a phone' })).status,
    ).toBe(400);
    expect(
      (
        await h
          .http()
          .post('/api/v1/auth/otp/verify')
          .send({ challengeId: 'x', phone: '+12025550100', code: '1' })
      ).status,
    ).toBe(400);
  });
});
