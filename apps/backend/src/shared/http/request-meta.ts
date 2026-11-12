import type { Request } from 'express';

/** Request facts recorded with security/audit events. Never contains bodies or credentials. */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export const NO_REQUEST_META: RequestMeta = { ip: null, userAgent: null, requestId: null };

export function requestMeta(req: Request): RequestMeta {
  const userAgent = req.get('user-agent');
  return {
    ip: req.ip ?? null,
    userAgent: userAgent === undefined ? null : userAgent.slice(0, 512),
    requestId: typeof req.id === 'string' ? req.id.slice(0, 128) : null,
  };
}
