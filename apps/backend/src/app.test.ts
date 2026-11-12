import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';
import type { DependencyCheck } from './modules/health/index.js';
import type { LivenessReport, ReadinessReport } from './modules/health/index.js';
import { errorBody, jsonBody } from './test-support/http.js';
import { silentLogger } from './test-support/silent-logger.js';

function buildApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    logger: silentLogger(),
    bodyLimit: '1kb',
    healthCheckTimeoutMs: 50,
    isShuttingDown: () => false,
    healthChecks: [],
    ...overrides,
  });
}

const up = (name: string): DependencyCheck => ({ name, check: () => Promise.resolve() });
const down = (name: string): DependencyCheck => ({
  name,
  check: () => Promise.reject(new Error('unreachable')),
});

describe('GET /health', () => {
  it('reports liveness without touching dependencies', async () => {
    const res = await request(buildApp({ healthChecks: [down('database')] })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(typeof jsonBody<LivenessReport>(res).uptimeSeconds).toBe('number');
  });

  it('sets a correlation id header', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('propagates a client-supplied correlation id', async () => {
    const res = await request(buildApp()).get('/health').set('X-Request-Id', 'trace-42');
    expect(res.headers['x-request-id']).toBe('trace-42');
  });

  it('does not expose x-powered-by', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when all dependencies are up', async () => {
    const res = await request(buildApp({ healthChecks: [up('database'), up('redis')] })).get(
      '/health/ready',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('returns 503 when a dependency is down', async () => {
    const res = await request(buildApp({ healthChecks: [up('database'), down('redis')] })).get(
      '/health/ready',
    );
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'not_ready',
      checks: { database: 'up', redis: 'down' },
    });
  });

  it('treats a hanging dependency as down after the timeout', async () => {
    const hanging: DependencyCheck = {
      name: 'database',
      check: () => new Promise(() => undefined),
    };
    const res = await request(buildApp({ healthChecks: [hanging] })).get('/health/ready');
    expect(res.status).toBe(503);
    expect(jsonBody<ReadinessReport>(res).checks).toEqual({ database: 'down' });
  });

  it('returns 503 while shutting down', async () => {
    const res = await request(
      buildApp({ healthChecks: [up('database')], isShuttingDown: () => true }),
    ).get('/health/ready');
    expect(res.status).toBe(503);
    expect(jsonBody<ReadinessReport>(res).status).toBe('not_ready');
  });
});

describe('error handling', () => {
  it('returns a uniform 404 envelope for unknown routes', async () => {
    const res = await request(buildApp()).get('/does-not-exist').set('X-Request-Id', 'abc');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /does-not-exist not found',
        requestId: 'abc',
      },
    });
  });

  it('returns 400 INVALID_JSON for malformed JSON bodies', async () => {
    const res = await request(buildApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(errorBody(res).code).toBe('INVALID_JSON');
  });

  it('returns 415 for an unsupported request charset', async () => {
    const res = await request(buildApp())
      .post('/health')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}');
    expect(res.status).toBe(415);
    expect(errorBody(res).code).toBe('UNSUPPORTED_ENCODING');
  });

  it('returns 413 when the body exceeds the limit', async () => {
    const res = await request(buildApp())
      .post('/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(2_048) }));
    expect(res.status).toBe(413);
    expect(errorBody(res).code).toBe('PAYLOAD_TOO_LARGE');
  });
});
