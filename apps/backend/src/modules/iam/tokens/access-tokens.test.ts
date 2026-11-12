import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AccessTokenService, createEnvKeyStore, InvalidAccessTokenError } from './access-tokens.js';

const pem = (key: ReturnType<typeof generateKeyPairSync>['privateKey']) =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString();

const keyPair = generateKeyPairSync('ed25519');
const otherPair = generateKeyPairSync('ed25519');
const settings = { issuer: 'medibook', audience: 'medibook-api', ttlSeconds: 900 };

function service(
  now = () => new Date(),
  keys = { privateKeyPem: pem(keyPair.privateKey), keyId: 'k1' },
) {
  return new AccessTokenService(
    createEnvKeyStore({
      ...settings,
      ...keys,
      previousKeyId: undefined,
      previousPublicKeyPem: undefined,
    }),
    settings,
    now,
  );
}

async function expectRejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(InvalidAccessTokenError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('AccessTokenService', () => {
  it('issues tokens with the required claims and verifies them', async () => {
    const svc = service();
    const { token, expiresAt } = await svc.issue('42', '7');
    const claims = await svc.verify(token);
    expect(claims).toMatchObject({ sub: '42', sid: '7' });
    expect(claims.exp - claims.iat).toBe(900);
    expect(expiresAt.getTime()).toBe(claims.exp * 1000);
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a tampered payload', async () => {
    const svc = service();
    const { token } = await svc.issue('42', '7');
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), sub: '1' }),
    ).toString('base64url');
    await expectRejected(svc.verify(`${header}.${forged}.${signature}`), 'INVALID_TOKEN');
  });

  it('rejects a token signed with another key under the same kid', async () => {
    const attacker = service(undefined, { privateKeyPem: pem(otherPair.privateKey), keyId: 'k1' });
    const { token } = await attacker.issue('42', '7');
    await expectRejected(service().verify(token), 'INVALID_TOKEN');
  });

  it('rejects expired tokens', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const svc = service(() => now);
    const { token } = await svc.issue('42', '7');
    now = new Date(now.getTime() + 901_000 + 5_000);
    await expectRejected(svc.verify(token), 'TOKEN_EXPIRED');
  });

  it('rejects unsigned (alg=none), unknown-kid, wrong-audience and malformed tokens', async () => {
    const svc = service();
    const none = new UnsecuredJWT({ sid: '7' })
      .setSubject('42')
      .setIssuer('medibook')
      .setAudience('medibook-api')
      .setIssuedAt()
      .setExpirationTime('5m')
      .encode();
    await expectRejected(svc.verify(none), 'INVALID_TOKEN');

    const signWith = (header: Record<string, string>, audience = 'medibook-api') =>
      new SignJWT({ sid: '7' })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', ...header })
        .setSubject('42')
        .setIssuer('medibook')
        .setAudience(audience)
        .setIssuedAt()
        .setJti('x')
        .setExpirationTime('5m')
        .sign(keyPair.privateKey);
    await expectRejected(svc.verify(await signWith({ kid: 'unknown' })), 'INVALID_TOKEN');
    await expectRejected(svc.verify(await signWith({ kid: 'k1' }, 'other-api')), 'INVALID_TOKEN');
    await expectRejected(svc.verify(await signWith({ kid: 'k1', typ: 'JWT' })), 'INVALID_TOKEN');
    await expectRejected(svc.verify('not.a.jwt'), 'INVALID_TOKEN');
  });

  it('rejects tokens with non-numeric subject or session ids', async () => {
    const token = await new SignJWT({ sid: '7 OR 1=1' })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' })
      .setSubject('42')
      .setIssuer('medibook')
      .setAudience('medibook-api')
      .setIssuedAt()
      .setJti('x')
      .setExpirationTime('5m')
      .sign(keyPair.privateKey);
    await expectRejected(service().verify(token), 'INVALID_TOKEN');
  });

  it('accepts the previous key during rotation and signs with the new one', async () => {
    const old = service(undefined, { privateKeyPem: pem(otherPair.privateKey), keyId: 'old' });
    const { token } = await old.issue('42', '7');
    const rotated = new AccessTokenService(
      createEnvKeyStore({
        ...settings,
        privateKeyPem: pem(keyPair.privateKey),
        keyId: 'new',
        previousKeyId: 'old',
        previousPublicKeyPem: otherPair.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      }),
      settings,
      () => new Date(),
    );
    await expect(rotated.verify(token)).resolves.toMatchObject({ sub: '42' });
    const fresh = await rotated.issue('42', '7');
    expect(
      JSON.parse(Buffer.from(fresh.token.split('.')[0]!, 'base64url').toString()),
    ).toMatchObject({ kid: 'new' });
  });

  it('refuses non-Ed25519 signing keys', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      createEnvKeyStore({
        ...settings,
        privateKeyPem: pem(rsa.privateKey),
        keyId: 'k',
        previousKeyId: undefined,
        previousPublicKeyPem: undefined,
      }),
    ).toThrow(/Ed25519/);
  });
});
