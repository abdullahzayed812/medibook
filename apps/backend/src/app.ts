import express, { type Express, type Router } from 'express';
import type { TrustProxySetting } from './config/env.js';
import type { Logger } from './shared/logger/logger.js';
import { errorHandler, notFoundHandler } from './shared/http/middleware/error-handler.js';
import { requestLogger } from './shared/http/middleware/request-logger.js';
import { createHealthModule, type DependencyCheck } from './modules/health/index.js';

export interface AppDependencies {
  readonly logger: Logger;
  readonly bodyLimit: string;
  readonly healthChecks: readonly DependencyCheck[];
  readonly healthCheckTimeoutMs: number;
  readonly isShuttingDown: () => boolean;
  /** Versioned business API, mounted at /api/v1. Omitted in infrastructure-only tests. */
  readonly apiRouter?: Router;
  readonly trustProxy?: TrustProxySetting;
}

/**
 * Builds the Express application. Pure construction: no ports are opened and no
 * connections are created here, which keeps the app testable with Supertest and fakes.
 * Process lifecycle (listen, signals, shutdown) lives in server.ts.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  // Determines req.ip, which rate limiting and security events rely on.
  app.set('trust proxy', deps.trustProxy ?? false);

  app.use(requestLogger(deps.logger));
  app.use(express.json({ limit: deps.bodyLimit }));

  const health = createHealthModule({
    checks: deps.healthChecks,
    timeoutMs: deps.healthCheckTimeoutMs,
    isShuttingDown: deps.isShuttingDown,
  });
  app.use('/health', health.router);

  if (deps.apiRouter !== undefined) {
    app.use('/api/v1', deps.apiRouter);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
