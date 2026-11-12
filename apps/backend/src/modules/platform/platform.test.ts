import { describe, expect, it } from 'vitest';
import { PrivateDocuments } from './documents.js';
import {
  LocalPrivateStorage,
  ProductionLocalStorageError,
  type PrivateObjectStorage,
} from './private-storage.js';
import { SETTING_DEFAULTS, settingsPatchSchema } from './settings.js';

const storage: PrivateObjectStorage = {
  name: 'fake',
  put: () => Promise.resolve(),
  get: () => Promise.resolve(Buffer.alloc(0)),
};
const docs = new PrivateDocuments(storage, {
  table: 'clinic_registration_documents',
  parentColumn: 'registration_request_id',
  keyPrefix: 'registration',
  types: ['BUSINESS_LICENSE', 'OTHER'],
});
const PDF = Buffer.from('%PDF-1.4 synthetic');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe('PrivateDocuments.validate', () => {
  it('accepts allowed types whose content matches', () => {
    expect(
      docs.validate({
        documentType: 'BUSINESS_LICENSE',
        filename: 'a.pdf',
        contentType: 'application/pdf',
        data: PDF,
      }),
    ).toBe('application/pdf');
    expect(
      docs.validate({
        documentType: 'OTHER',
        filename: 'a.png',
        contentType: 'image/png; charset=binary',
        data: PNG,
      }),
    ).toBe('image/png');
  });

  it('rejects disguised content, unknown types, empty and oversized files', () => {
    const v = (patch: object) => () =>
      docs.validate({
        documentType: 'OTHER',
        filename: 'x',
        contentType: 'application/pdf',
        data: PDF,
        ...patch,
      });
    expect(v({ data: PNG })).toThrow(expect.objectContaining({ code: 'CONTENT_MISMATCH' }));
    expect(v({ contentType: 'text/html' })).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
    );
    expect(v({ documentType: 'PASSPORT' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(v({ data: Buffer.alloc(0) })).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    expect(v({ data: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]) })).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });
});

describe('LocalPrivateStorage', () => {
  it('cannot be used in production', () => {
    expect(() => new LocalPrivateStorage('/tmp/x', 'production')).toThrow(
      ProductionLocalStorageError,
    );
  });

  it('only accepts server-generated keys (no path traversal)', async () => {
    const local = new LocalPrivateStorage('/tmp/medibook-unit', 'test');
    await expect(local.get('../../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(local.get('private/registration/../x')).rejects.toThrow(/Invalid storage key/);
  });
});

describe('platform settings', () => {
  it('defaults the grace period to 3 days and validates patches strictly', () => {
    expect(SETTING_DEFAULTS['subscription.grace_period_days']).toBe(3);
    expect(settingsPatchSchema.safeParse({ 'subscription.grace_period_days': 5 }).success).toBe(
      true,
    );
    expect(settingsPatchSchema.safeParse({ 'subscription.grace_period_days': -1 }).success).toBe(
      false,
    );
    expect(settingsPatchSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
});
