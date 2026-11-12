import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorBody, jsonBody } from '../../../test-support/http.js';
import { silentLogger } from '../../../test-support/silent-logger.js';
import { errorHandler } from './error-handler.js';
import { requestLogger } from './request-logger.js';
import { validate } from './validate.js';

function buildApp() {
  const app = express();
  app.use(requestLogger(silentLogger()));
  app.use(express.json());
  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      body: z.object({ name: z.string().min(1) }),
    }),
    (req, res) => {
      res.json({ params: req.params, query: req.query, body: req.body as unknown });
    },
  );
  app.use(errorHandler);
  return app;
}

describe('validate middleware', () => {
  it('replaces raw input with parsed values', async () => {
    const res = await request(buildApp())
      .post('/items/7?page=3')
      .send({ name: 'Widget', unknownField: 'stripped' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: 7 }, query: { page: 3 }, body: { name: 'Widget' } });
  });

  it('applies schema defaults', async () => {
    const res = await request(buildApp()).post('/items/1').send({ name: 'x' });
    expect(jsonBody<{ query: unknown }>(res).query).toEqual({ page: 1 });
  });

  it('collects issues from every location into one 400 response', async () => {
    const res = await request(buildApp()).post('/items/abc?page=0').send({ name: '' });
    expect(res.status).toBe(400);
    expect(errorBody(res).code).toBe('VALIDATION_ERROR');
    const locations = (errorBody(res).details as { location: string }[]).map((d) => d.location);
    expect(new Set(locations)).toEqual(new Set(['params', 'query', 'body']));
  });
});
