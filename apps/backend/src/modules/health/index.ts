/**
 * Health module public API. Other code imports from this file only, never from the
 * module's internal files: this is the module boundary.
 */
import type { Router } from 'express';
import { HealthController } from './health.controller.js';
import { createHealthRouter } from './health.routes.js';
import { HealthService, type HealthServiceOptions } from './health.service.js';

export type { DependencyCheck, LivenessReport, ReadinessReport } from './health.service.js';

export function createHealthModule(options: HealthServiceOptions): { router: Router } {
  const service = new HealthService(options);
  return { router: createHealthRouter(new HealthController(service)) };
}
