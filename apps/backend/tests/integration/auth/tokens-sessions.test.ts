import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/shared/security/crypto.js';
import { createHarness } from '../support/harness.js';
import { body, login, testDevice, testPhone } from '../support/fixtures.js';

const h = createHarness();
afterAll(() => h.close());
beforeEach(() => h.reset());

const refresh = (refreshToken: string) =>
  h.http().post('/api/v1/auth/refresh').send({ refreshToken });
const me = (bearer: string) => h.http().get('/api/v1/me').set('Authorization', bearer);
const errorCode = (res: { body: unknown }) => body<{ error: { code: string } }>(res).error.code;

interface Pair {
  accessToken: string;
  refreshToken: string;
}

describe('refresh tokens', () => {
  it('rotates: each refresh returns a new pair and invalidates the old refresh token', async () => {
    const s = await login(h, testPhone());
    const r1 = await refresh(s.refreshToken);
    expect(r1.status).toBe(200);
    const p1 = body<{ data: Pair }>(r1).data;
    expect(p1.refreshToken).not.toBe(s.refreshToken);
    expect((await me(`Bearer ${p1.accessToken}`)).status).toBe(200);

    const r2 = await refresh(p1.refreshToken);
    expect(r2.status).toBe(200);
    const statuses = await h.db.query<{ status: string }>(
      'SELECT status FROM refresh_tokens WHERE session_id = ? ORDER BY id',
      [s.sessionId],
    );
    expect(statuses.map((r) => r.status)).toEqual(['ROTATED', 'ROTATED', 'ACTIVE']);
  });

  it('detects reuse of a rotated token and revokes the whole session (token family)', async () => {
    const s = await login(h, testPhone());
    const rotated = body<{ data: Pair }>(await refresh(s.refreshToken)).data;

    const replay = await refresh(s.refreshToken); // attacker replays the stolen, already-used token
    expect(replay.status).toBe(401);
    expect(errorCode(replay)).toBe('SESSION_INVALID');

    // The legitimate (newer) token and the access token stop working too.
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    expect((await me(`Bearer ${rotated.accessToken}`)).status).toBe(401);

    const [session] = await h.db.query<{ revoked_reason: string }>(
      'SELECT revoked_reason FROM sessions WHERE id = ?',
      [s.sessionId],
    );
    expect(session?.revoked_reason).toBe('REFRESH_TOKEN_REUSE');
    const events = await h.db.query(
      `SELECT id FROM security_events WHERE event_type = 'REFRESH_TOKEN_REUSE_DETECTED' AND session_id = ?`,
      [s.sessionId],
    );
    expect(events).toHaveLength(1);
  });

  it('stores only SHA-256 hashes of refresh tokens', async () => {
    const s = await login(h, testPhone());
    const rows = await h.db.query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens WHERE session_id = ?',
      [s.sessionId],
    );
    expect(rows).toEqual([{ token_hash: sha256Hex(s.refreshToken) }]);
    const all = JSON.stringify(await h.db.query('SELECT * FROM refresh_tokens'));
    expect(all).not.toContain(s.refreshToken);
  });

  it('rejects expired refresh tokens', async () => {
    const s = await login(h, testPhone());
    h.clock.advance(31 * 86_400_000);
    const res = await refresh(s.refreshToken);
    expect(res.status).toBe(401);
  });

  it('rejects unknown and malformed refresh tokens uniformly', async () => {
    expect(errorCode(await refresh('A'.repeat(43)))).toBe('SESSION_INVALID');
    expect((await refresh('short')).status).toBe(400);
  });
});

describe('sessions', () => {
  it('rejects requests with a revoked session immediately (logout), not at token expiry', async () => {
    const s = await login(h, testPhone());
    expect((await me(s.bearer)).status).toBe(200);
    expect((await h.http().post('/api/v1/auth/logout').set('Authorization', s.bearer)).status).toBe(
      204,
    );
    const after = await me(s.bearer);
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('SESSION_INVALID');
    expect((await refresh(s.refreshToken)).status).toBe(401);
  });

  it('logout-all revokes every session of the user', async () => {
    const phone = testPhone();
    const a = await login(h, phone, { device: testDevice('PATIENT_MOBILE') });
    const b = await login(h, phone, { device: testDevice('PATIENT_WEB') });
    expect(
      (await h.http().post('/api/v1/auth/logout-all').set('Authorization', a.bearer)).status,
    ).toBe(204);
    expect((await me(a.bearer)).status).toBe(401);
    expect((await me(b.bearer)).status).toBe(401);
  });

  it('lists active sessions with device details and marks the current one', async () => {
    const phone = testPhone();
    const a = await login(h, phone, { device: testDevice('PATIENT_MOBILE') });
    await login(h, phone, { device: testDevice('PATIENT_WEB') });
    const res = await h
      .http()
      .get('/api/v1/sessions')
      .set('Authorization', a.bearer)
      .set('User-Agent', 'it-agent');
    expect(res.status).toBe(200);
    const sessions = body<{
      data: { id: string; current: boolean; appType: string; deviceName: string }[];
    }>(res).data;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((x) => x.current).map((x) => x.id)).toEqual([a.sessionId]);
    expect(sessions[0]).toMatchObject({ deviceName: 'Test Device' });
    expect(JSON.stringify(sessions)).not.toMatch(/token/i);
  });

  it('revokes a single session and refuses to touch sessions of other users', async () => {
    const phone = testPhone();
    const a = await login(h, phone, { device: testDevice('PATIENT_MOBILE') });
    const b = await login(h, phone, { device: testDevice('PATIENT_WEB') });
    const stranger = await login(h, testPhone());

    expect(
      (
        await h
          .http()
          .delete(`/api/v1/sessions/${stranger.sessionId}`)
          .set('Authorization', a.bearer)
      ).status,
    ).toBe(404);
    expect((await me(stranger.bearer)).status).toBe(200);

    expect(
      (await h.http().delete(`/api/v1/sessions/${b.sessionId}`).set('Authorization', a.bearer))
        .status,
    ).toBe(204);
    expect((await me(b.bearer)).status).toBe(401);
    expect((await me(a.bearer)).status).toBe(200);
  });

  it('revokes all other sessions but keeps the current one', async () => {
    const phone = testPhone();
    const a = await login(h, phone, { device: testDevice('PATIENT_MOBILE') });
    const b = await login(h, phone, { device: testDevice('PATIENT_WEB') });
    const c = await login(h, phone, { device: testDevice('STAFF_MOBILE') });
    const res = await h.http().delete('/api/v1/sessions').set('Authorization', a.bearer);
    expect(body<{ data: { revoked: number } }>(res).data.revoked).toBe(2);
    expect((await me(a.bearer)).status).toBe(200);
    expect((await me(b.bearer)).status).toBe(401);
    expect((await me(c.bearer)).status).toBe(401);
  });

  it('replaces the previous session when logging in again on the same device and app', async () => {
    const phone = testPhone();
    const device = testDevice('PATIENT_MOBILE');
    const first = await login(h, phone, { device });
    const second = await login(h, phone, { device });
    expect((await me(first.bearer)).status).toBe(401);
    expect((await me(second.bearer)).status).toBe(200);
  });

  it('expires sessions at their absolute lifetime even with valid-looking tokens', async () => {
    const s = await login(h, testPhone());
    await h.db.execute('UPDATE sessions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000),
      s.sessionId,
    ]);
    expect((await me(s.bearer)).status).toBe(401);
    expect((await refresh(s.refreshToken)).status).toBe(401);
  });

  it('records refresh, logout and revocation events', async () => {
    const s = await login(h, testPhone());
    await refresh(s.refreshToken);
    const fresh = await login(h, testPhone());
    await h.http().post('/api/v1/auth/logout').set('Authorization', fresh.bearer);
    const types = (
      await h.db.query<{ event_type: string }>('SELECT event_type FROM security_events')
    ).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['TOKEN_REFRESHED', 'LOGOUT']));
  });
});
