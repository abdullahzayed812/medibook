import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from './base32.js';
import {
  decrypt,
  deriveKey,
  encrypt,
  hexDigestsEqual,
  hmacSha256Hex,
  randomToken,
} from './crypto.js';
import { hotp, totpStep, verifyTotp } from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP / TOTP', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => {
      expect(hotp(RFC_SECRET, counter)).toBe(code);
    });
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches the RFC 6238 SHA-1 vector at T=%i', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(new Date(seconds * 1000)), 8)).toBe(code);
  });

  it('accepts ±1 step of drift and returns the matched step', () => {
    const at = new Date(1_700_000_000_000);
    const step = totpStep(at);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), at)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), at)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), at)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, 'abcdef', at)).toBeUndefined();
  });
});

describe('base32', () => {
  it('round-trips and matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(() => base32Decode('not*base32')).toThrow();
  });
});

describe('crypto helpers', () => {
  it('derives independent keys per purpose', () => {
    expect(
      deriveKey('master-secret-master-secret-1234', 'a').equals(
        deriveKey('master-secret-master-secret-1234', 'b'),
      ),
    ).toBe(false);
    expect(deriveKey('master-secret-master-secret-1234', 'a')).toHaveLength(32);
  });

  it('compares digests in constant time and rejects length mismatches', () => {
    const key = Buffer.alloc(32, 1);
    expect(hexDigestsEqual(hmacSha256Hex(key, 'x'), hmacSha256Hex(key, 'x'))).toBe(true);
    expect(hexDigestsEqual(hmacSha256Hex(key, 'x'), hmacSha256Hex(key, 'y'))).toBe(false);
    expect(hexDigestsEqual('ab', 'abcd')).toBe(false);
    expect(hexDigestsEqual('', '')).toBe(false);
  });

  it('generates high-entropy url-safe tokens', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(32)).not.toBe(token);
  });

  it('encrypts with authentication: tampering, wrong AAD and wrong key are rejected', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = encrypt(key, Buffer.from('secret'), 'user:1');
    expect(decrypt(key, sealed, 'user:1').toString()).toBe('secret');
    expect(() => decrypt(key, sealed, 'user:2')).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 8), sealed, 'user:1')).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(key, tampered, 'user:1')).toThrow();
  });
});
