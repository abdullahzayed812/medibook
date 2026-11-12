import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../test-support/silent-logger.js';
import { MockOtpProvider, ProductionMockProviderError } from './otp-provider.js';

describe('MockOtpProvider', () => {
  it('cannot be constructed in production', () => {
    expect(() => new MockOtpProvider(silentLogger(), 'production')).toThrow(
      ProductionMockProviderError,
    );
  });

  it('records sent codes for development and tests', async () => {
    const provider = new MockOtpProvider(silentLogger(), 'test');
    await provider.send({
      phoneE164: '+12025550123',
      code: '123456',
      purpose: 'LOGIN',
      expiresAt: new Date(),
    });
    expect(provider.lastCodeFor('+12025550123')).toBe('123456');
    expect(provider.sentCount('+12025550123')).toBe(1);
  });
});
