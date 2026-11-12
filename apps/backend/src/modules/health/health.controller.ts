import type { RequestHandler } from 'express';
import type { HealthService } from './health.service.js';

/**
 * HTTP adapter for the health service. Controllers translate HTTP ↔ service calls only;
 * they contain no business or infrastructure logic.
 */
export class HealthController {
  constructor(private readonly service: HealthService) {}

  live: RequestHandler = (_req, res) => {
    res.status(200).json(this.service.liveness());
  };

  ready: RequestHandler = async (_req, res) => {
    const report = await this.service.readiness();
    res.status(report.status === 'ready' ? 200 : 503).json(report);
  };
}
