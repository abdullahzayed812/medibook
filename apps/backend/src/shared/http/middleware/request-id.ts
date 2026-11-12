import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept only short, safe client-supplied IDs to prevent log injection. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Resolves the correlation ID for a request: reuses a well-formed incoming
 * `X-Request-Id` (e.g. from a gateway or client) or generates a UUID v4, and
 * echoes it back on the response. Used as pino-http's `genReqId`, so the same
 * ID is attached to every log line of the request and to error responses.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}
