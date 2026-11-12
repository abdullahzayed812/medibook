import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { ValidationError } from '../../shared/errors/app-error.js';

/**
 * Normalizes user input to E.164 (e.g. "+9647701234567"). Numbers without a leading "+" are
 * only accepted when a default region is configured. Invalid numbers are rejected with the
 * same generic error regardless of whether any account uses them.
 */
export function normalizePhone(raw: string, defaultRegion?: string): string {
  const input = raw.trim();
  if (input.length === 0 || input.length > 32) throw invalidPhone();
  const parsed = parsePhoneNumberFromString(input, {
    ...(defaultRegion === undefined ? {} : { defaultCountry: defaultRegion as CountryCode }),
    extract: false,
  });
  if (parsed?.isValid() !== true) throw invalidPhone();
  return parsed.number;
}

/** "+9647701234567" → "+964•••••4567". Use whenever a phone must appear in logs or UIs. */
export function maskPhone(e164: string): string {
  if (e164.length <= 7) return '•'.repeat(e164.length);
  return `${e164.slice(0, 4)}${'•'.repeat(e164.length - 8)}${e164.slice(-4)}`;
}

function invalidPhone(): ValidationError {
  return new ValidationError(
    [{ location: 'body', path: 'phone', message: 'Invalid phone number' }],
    'Invalid phone number',
  );
}
