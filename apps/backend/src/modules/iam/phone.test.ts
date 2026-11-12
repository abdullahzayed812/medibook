import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../shared/errors/app-error.js';
import { maskPhone, normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('normalizes international input to E.164', () => {
    expect(normalizePhone('+1 (202) 555-0123')).toBe('+12025550123');
    expect(normalizePhone('  +44 20 7946 0958 ')).toBe('+442079460958');
  });

  it('accepts national numbers only with a default region', () => {
    expect(() => normalizePhone('202-555-0123')).toThrow(ValidationError);
    expect(normalizePhone('202-555-0123', 'US')).toBe('+12025550123');
  });

  it.each(['', 'abc', '+1', '+999999', '1'.repeat(40), '+1 202 555 0123 ext 5 and more junk text'])(
    'rejects %j with a generic error',
    (input) => {
      expect(() => normalizePhone(input)).toThrow('Invalid phone number');
    },
  );
});

describe('maskPhone', () => {
  it('keeps only the country prefix and last four digits', () => {
    expect(maskPhone('+12025550123')).toBe('+120••••0123');
  });
});
