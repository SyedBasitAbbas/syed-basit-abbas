import type { Actor } from '../../../../shared/domain/actor.js';

/**
 * Domain-level authorization for chat. Re-checked inside every use case,
 * independently of the role gates on the routes.
 */
export const ChatPolicy = {
  canAsk(actor: Actor): boolean {
    return actor.hasRole('user') || actor.isAdmin;
  },

  canRead(actor: Actor, message: { userId: string }): boolean {
    return actor.isAdmin || actor.owns(message);
  },

  canReadUsageOf(actor: Actor, userId: string): boolean {
    return actor.isAdmin || actor.userId === userId;
  },

  canListAll(actor: Actor): boolean {
    return actor.isAdmin;
  },
} as const;
