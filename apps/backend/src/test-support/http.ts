import type { ErrorResponseBody } from '../shared/http/error-response.js';

/**
 * Supertest exposes `res.body` as `any`. These helpers give it an explicit type in tests,
 * keeping `no-unsafe-*` lint rules enabled everywhere.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- deliberate typed cast for test assertions
export function jsonBody<T>(res: { body: unknown }): T {
  return res.body as T;
}

export function errorBody(res: { body: unknown }): ErrorResponseBody['error'] {
  return jsonBody<ErrorResponseBody>(res).error;
}
