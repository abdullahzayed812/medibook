import { Router } from 'express';
import type { HealthController } from './health.controller.js';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get('/', controller.live);
  router.get('/ready', controller.ready);
  return router;
}
