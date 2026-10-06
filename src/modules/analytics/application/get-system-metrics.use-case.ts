import type { Actor } from '../../../shared/domain/actor.js';
import type { Clock } from '../../../shared/domain/clock.js';
import { ForbiddenError } from '../../../shared/domain/errors.js';
import { AnalyticsPolicy } from '../domain/policies/analytics.policy.js';
import type { MetricsRepository, SystemMetrics } from '../repositories/metrics.repository.js';

export class GetSystemMetricsUseCase {
  constructor(private readonly deps: { metrics: MetricsRepository; clock: Clock }) {}

  async execute(actor: Actor): Promise<SystemMetrics & { generatedAt: Date }> {
    if (!AnalyticsPolicy.canViewSystemMetrics(actor)) {
      throw new ForbiddenError('Only administrators can read system metrics.');
    }
    const now = this.deps.clock.now();
    return { ...(await this.deps.metrics.collect(now)), generatedAt: now };
  }
}
