import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorBody } from '../../../test-support/http.js';
import { silentLogger } from '../../../test-support/silent-logger.js';
import { AppError, ConflictError, ForbiddenError } from '../../errors/app-error.js';
import { errorHandler, notFoundHandler } from './error-handler.js';
import { requestLogger } from './request-logger.js';

function appThrowing(err: unknown) {
  const app = express();
  app.use(requestLogger(silentLogger()));
  app.get('/sync', () => {
    throw err;
  });
  app.get('/async', async () => {
    await Promise.resolve();
    throw err;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it.each(['/sync', '/async'])('maps AppError subclasses to their status (%s)', async (path) => {
    const res = await request(appThrowing(new ConflictError('Slot taken', { slot: 1 }))).get(path);
    expect(res.status).toBe(409);
    expect(errorBody(res)).toMatchObject({
      code: 'CONFLICT',
      message: 'Slot taken',
      details: { slot: 1 },
    });
    expect(errorBody(res).requestId).toBe(res.headers['x-request-id']);
  });

  it('omits details when none are provided', async () => {
    const res = await request(appThrowing(new ForbiddenError())).get('/sync');
    expect(res.status).toBe(403);
    expect(errorBody(res)).not.toHaveProperty('details');
  });

  it('hides internals of unexpected errors behind a generic 500', async () => {
    const res = await request(appThrowing(new Error('SELECT * FROM secrets failed'))).get('/async');
    expect(res.status).toBe(500);
    expect(errorBody(res).code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secrets');
  });

  it('handles non-Error throwables', async () => {
    const res = await request(appThrowing('a string')).get('/sync');
    expect(res.status).toBe(500);
  });

  it('supports custom AppError instances', async () => {
    const res = await request(appThrowing(new AppError(422, 'UNPROCESSABLE', 'Nope'))).get('/sync');
    expect(res.status).toBe(422);
    expect(errorBody(res).code).toBe('UNPROCESSABLE');
  });
});
