import type { Page, PageRequest } from '../../../shared/application/pagination.js';
import type { Actor } from '../../../shared/domain/actor.js';
import { ForbiddenError, NotFoundError } from '../../../shared/domain/errors.js';
import type { SubscriptionStatus } from '../domain/entities/subscription.js';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy.js';
import { PLAN_CATALOG, type Plan } from '../domain/services/plan-catalog.js';
import type {
  SubscriptionRepository,
  SubscriptionView,
} from '../repositories/subscription.repository.js';

export class SubscriptionQueries {
  constructor(private readonly deps: { subscriptions: SubscriptionRepository }) {}

  listPlans(): Plan[] {
    return Object.values(PLAN_CATALOG);
  }

  async get(actor: Actor, subscriptionId: string): Promise<SubscriptionView> {
    const view = await this.deps.subscriptions.findViewById(subscriptionId);
    if (!view || !SubscriptionPolicy.canView(actor, view.subscription)) {
      throw new NotFoundError('Subscription');
    }
    return view;
  }

  async listOwn(
    actor: Actor,
    filter: { status?: SubscriptionStatus },
    page: PageRequest,
  ): Promise<Page<SubscriptionView>> {
    return this.deps.subscriptions.list({ ...filter, userId: actor.userId }, page);
  }

  async listAll(
    actor: Actor,
    filter: { userId?: string; status?: SubscriptionStatus },
    page: PageRequest,
  ): Promise<Page<SubscriptionView>> {
    if (!SubscriptionPolicy.canListAll(actor)) {
      throw new ForbiddenError('Only administrators can list all subscriptions.');
    }
    return this.deps.subscriptions.list(filter, page);
  }
}
