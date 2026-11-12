import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT, type JWTHeaderParameters } from 'jose';
import type { AppConfig } from '../../../config/env.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { Clock } from '../../../shared/security/clock.js';
import { randomHex } from '../../../shared/security/crypto.js';

const ALGORITHM = 'EdDSA';
const TOKEN_TYPE = 'at+jwt';
const ID_PATTERN = /^[1-9]\d{0,19}$/;

export interface AccessTokenClaims {
  /** User id. */
  readonly sub: string;
  /** Session id; the session is re-checked in MySQL on every request. */
  readonly sid: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Source of signing/verification keys. The default implementation reads environment
 * configuration; a secrets-manager / KMS implementation can replace it without touching callers.
 */
export interface AccessTokenKeyStore {
  readonly signingKey: { readonly kid: string; readonly key: KeyObject };
  verificationKey(kid: string): KeyObject | undefined;
}

export function createEnvKeyStore(config: AppConfig['auth']['accessToken']): AccessTokenKeyStore {
  const privateKey = createPrivateKey(config.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('AUTH_ACCESS_TOKEN_PRIVATE_KEY must be an Ed25519 private key');
  }
  const verification = new Map<string, KeyObject>([[config.keyId, createPublicKey(privateKey)]]);
  if (config.previousKeyId !== undefined && config.previousPublicKeyPem !== undefined) {
    const previous = createPublicKey(config.previousPublicKeyPem);
    if (previous.asymmetricKeyType !== 'ed25519') {
      throw new Error('AUTH_ACCESS_TOKEN_PREVIOUS_PUBLIC_KEY must be an Ed25519 public key');
    }
    verification.set(config.previousKeyId, previous);
  }
  return {
    signingKey: { kid: config.keyId, key: privateKey },
    verificationKey: (kid) => verification.get(kid),
  };
}

export class InvalidAccessTokenError extends AppError {
  constructor(code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED') {
    super(401, code, code === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Invalid access token');
  }
}

/**
 * Short-lived access tokens (JWT, EdDSA/Ed25519). They carry identity only (user + session):
 * roles, memberships and permissions are always resolved from MySQL per request, so changes
 * take effect immediately and never rely on token expiry.
 */
export class AccessTokenService {
  constructor(
    private readonly keys: AccessTokenKeyStore,
    private readonly config: Pick<
      AppConfig['auth']['accessToken'],
      'issuer' | 'audience' | 'ttlSeconds'
    >,
    private readonly clock: Clock,
  ) {}

  async issue(userId: string, sessionId: string): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(this.clock().getTime() / 1000);
    const expiresAt = issuedAt + this.config.ttlSeconds;
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.keys.signingKey.kid, typ: TOKEN_TYPE })
      .setSubject(userId)
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(randomHex(16))
      .sign(this.keys.signingKey.key);
    return { token, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Verifies signature, algorithm, type, issuer, audience, expiry and required claims. */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header: JWTHeaderParameters) => {
          const key = header.kid === undefined ? undefined : this.keys.verificationKey(header.kid);
          if (key === undefined) throw new InvalidAccessTokenError('INVALID_TOKEN');
          return key;
        },
        {
          algorithms: [ALGORITHM],
          typ: TOKEN_TYPE,
          issuer: this.config.issuer,
          audience: this.config.audience,
          currentDate: this.clock(),
          clockTolerance: 5,
          requiredClaims: ['sub', 'sid', 'jti', 'iat', 'exp'],
        },
      );
      const { sub, sid, jti, iat, exp } = payload;
      if (
        typeof sub !== 'string' ||
        !ID_PATTERN.test(sub) ||
        typeof sid !== 'string' ||
        !ID_PATTERN.test(sid) ||
        typeof jti !== 'string' ||
        typeof iat !== 'number' ||
        typeof exp !== 'number'
      ) {
        throw new InvalidAccessTokenError('INVALID_TOKEN');
      }
      return { sub, sid, jti, iat, exp };
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) throw err;
      if (err instanceof joseErrors.JWTExpired) throw new InvalidAccessTokenError('TOKEN_EXPIRED');
      throw new InvalidAccessTokenError('INVALID_TOKEN');
    }
  }
}
