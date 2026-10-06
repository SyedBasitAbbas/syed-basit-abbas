import type { Actor } from '../../../../shared/domain/actor.js';

export const AnalyticsPolicy = {
  canViewSystemMetrics(actor: Actor): boolean {
    return actor.isAdmin;
  },
} as const;
