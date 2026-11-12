import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

function fakeReq(header?: string | string[]): IncomingMessage {
  return {
    headers: header === undefined ? {} : { [REQUEST_ID_HEADER]: header },
  } as IncomingMessage;
}

function fakeRes() {
  const setHeader = vi.fn();
  return { res: { setHeader } as unknown as ServerResponse, setHeader };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('generates a UUID when no header is present and echoes it', () => {
    const { res, setHeader } = fakeRes();
    const id = resolveRequestId(fakeReq(), res);
    expect(id).toMatch(UUID);
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, id);
  });

  it('reuses a well-formed incoming id', () => {
    const { res } = fakeRes();
    expect(resolveRequestId(fakeReq('gateway-abc.123'), res)).toBe('gateway-abc.123');
  });

  it('uses the first value when the header is repeated', () => {
    const { res } = fakeRes();
    expect(resolveRequestId(fakeReq(['first', 'second']), res)).toBe('first');
  });

  it.each([['has spaces'], ['line\nbreak'], ['x'.repeat(129)], [''], ['<script>']])(
    'replaces unsafe incoming id %j',
    (value) => {
      const { res } = fakeRes();
      expect(resolveRequestId(fakeReq(value), res)).toMatch(UUID);
    },
  );
});
