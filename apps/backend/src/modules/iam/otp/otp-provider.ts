import type { AppConfig } from '../../../config/env.js';
import type { Logger } from '../../../shared/logger/logger.js';
import { maskPhone } from '../phone.js';

export interface OtpMessage {
  readonly phoneE164: string;
  readonly code: string;
  readonly purpose: 'LOGIN' | 'GUEST_BOOKING' | 'PHONE_CHANGE';
  readonly expiresAt: Date;
}

/**
 * Delivery channel for OTP codes. Real SMS/WhatsApp/email providers implement this interface
 * in a later task; nothing else in the auth flow depends on the transport.
 */
export interface OtpProvider {
  readonly name: string;
  send(message: OtpMessage): Promise<void>;
}

export class ProductionMockProviderError extends Error {
  constructor() {
    super('The mock OTP provider must never run in production');
    this.name = 'ProductionMockProviderError';
  }
}

/**
 * DEVELOPMENT/TEST ONLY. Writes the code to the dev log and keeps an in-memory outbox that tests
 * read. Refuses to be constructed when NODE_ENV is production (second line of defense after
 * config validation), so it cannot be enabled by accident.
 */
export class MockOtpProvider implements OtpProvider {
  readonly name = 'mock';
  private readonly outbox: OtpMessage[] = [];

  constructor(
    private readonly logger: Logger,
    nodeEnv: string = process.env.NODE_ENV ?? 'development',
  ) {
    if (nodeEnv === 'production') throw new ProductionMockProviderError();
  }

  send(message: OtpMessage): Promise<void> {
    this.outbox.push(message);
    this.logger.warn(
      { phone: maskPhone(message.phoneE164), devOtp: message.code, purpose: message.purpose },
      'DEV ONLY: mock OTP provider "sent" a code',
    );
    return Promise.resolve();
  }

  /** Test helper: the most recent code sent to a phone. */
  lastCodeFor(phoneE164: string): string | undefined {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const message = this.outbox[i];
      if (message?.phoneE164 === phoneE164) return message.code;
    }
    return undefined;
  }

  sentCount(phoneE164: string): number {
    return this.outbox.filter((message) => message.phoneE164 === phoneE164).length;
  }
}

export function createOtpProvider(config: AppConfig, logger: Logger): OtpProvider {
  // Only the mock exists until a real SMS provider is approved; new providers add a branch here.
  const provider: string = config.otp.provider;
  if (provider === 'mock') return new MockOtpProvider(logger, config.env);
  throw new Error(`Unsupported OTP provider "${provider}"`);
}
