import { pinoHttp } from 'pino-http';
import type { Logger } from '../../logger/logger.js';
import { resolveRequestId } from './request-id.js';

/**
 * Structured access logging with correlation IDs. Exposes `req.log`, a child
 * logger bound to the request ID, for use in handlers and the error handler.
 */
export function requestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: resolveRequestId,
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Keep access logs small; never log bodies (they may contain patient data).
    serializers: {
      req: (req: { id: unknown; method: unknown; url: unknown }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: unknown }) => ({ statusCode: res.statusCode }),
    },
  });
}
