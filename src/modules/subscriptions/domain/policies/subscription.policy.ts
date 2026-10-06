import type { Actor } from '../../../../shared/domain/actor.js';

/**
 * Domain-level authorization for subscriptions. Controllers also gate routes by
 * role; these rules are re-checked inside every use case so a wiring mistake in
 * the transport layer can never expose someone else's subscription.
 */
export const SubscriptionPolicy = {
  canPurchase(actor: Actor): boolean {
    return actor.hasRole('user') || actor.isAdmin;
  },

  canView(actor: Actor, subscription: { userId: string }): boolean {
    return actor.isAdmin || actor.owns(subscription);
  },

  canManage(actor: Actor, subscription: { userId: string }): boolean {
    return actor.isAdmin || actor.owns(subscription);
  },

  canListAll(actor: Actor): boolean {
    return actor.isAdmin;
  },

  canRunBilling(actor: Actor): boolean {
    return actor.isAdmin;
  },
} as const;
