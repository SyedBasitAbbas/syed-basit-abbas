import { Router } from 'express';
import { endpoint } from '../../../shared/infrastructure/http/endpoint.js';
import type { GetSystemMetricsUseCase } from '../application/get-system-metrics.use-case.js';

/** Admin-only, mounted under `/api/v1/admin`. */
export function metricsRoutes(deps: { metrics: GetSystemMetricsUseCase }): Router {
  const router = Router();
  router.get(
    '/metrics',
    endpoint({}, async ({ actor }) => {
      const metrics = await deps.metrics.execute(actor);
      return { status: 200, body: { ...metrics, generatedAt: metrics.generatedAt.toISOString() } };
    }),
  );
  return router;
}
