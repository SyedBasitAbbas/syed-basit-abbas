import { Router } from 'express';
import { z } from 'zod';
import { endpoint } from '../../../shared/infrastructure/http/endpoint.js';
import {
  encodeCursor,
  pageQueryShape,
  toPageRequest,
} from '../../../shared/infrastructure/http/schemas.js';
import type { RunBillingCycleUseCase } from '../application/run-billing-cycle.use-case.js';
import type { SubscriptionCommands } from '../application/subscription-commands.js';
import type { SubscriptionQueries } from '../application/subscription-queries.js';
import {
  BILLING_CYCLES,
  messageAllowance,
  SUBSCRIPTION_TIERS,
  type Plan,
} from '../domain/services/plan-catalog.js';
import type { SubscriptionView } from '../repositories/subscription.repository.js';

// Clients choose only these fields. Price, allowance, owner, dates and status are
// derived server-side, and strict schemas reject anything else (mass assignment).
const PurchaseBody = z.strictObject({
  tier: z.enum(SUBSCRIPTION_TIERS),
  billingCycle: z.enum(BILLING_CYCLES),
  autoRenew: z.boolean().default(true),
});
const UpdateBody = z.strictObject({ autoRenew: z.boolean() });
const SubscriptionParams = z.strictObject({ subscriptionId: z.uuid() });
const StatusFilter = z.enum(['active', 'inactive']).optional();
const ListQuery = z.strictObject({ ...pageQueryShape, status: StatusFilter });
const AdminListQuery = z.strictObject({
  ...pageQueryShape,
  status: StatusFilter,
  userId: z.uuid().optional(),
});

export function presentSubscription(view: SubscriptionView) {
  const s = view.subscription;
  return {
    id: s.id,
    userId: s.userId,
    tier: s.tier,
    billingCycle: s.billingCycle,
    status: s.status,
    inactiveReason: s.inactiveReason,
    autoRenew: s.autoRenew,
    maxMessages: s.maxMessages,
    unlimited: s.maxMessages === null,
    price: { amountCents: s.priceCents, currency: s.currency },
    startDate: s.startDate.toISOString(),
    endDate: s.endDate.toISOString(),
    renewalDate: s.renewalDate?.toISOString() ?? null,
    cancelledAt: s.cancelledAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    currentPeriodUsage: view.usage,
  };
}

function presentPlan(plan: Plan) {
  return {
    tier: plan.tier,
    monthlyMessages: plan.monthlyMessages,
    unlimited: plan.monthlyMessages === null,
    maxMessagesPerCycle: {
      monthly: messageAllowance(plan, 'monthly'),
      yearly: messageAllowance(plan, 'yearly'),
    },
    prices: {
      monthly: { amountCents: plan.priceCents.monthly, currency: plan.currency },
      yearly: { amountCents: plan.priceCents.yearly, currency: plan.currency },
    },
  };
}

export interface SubscriptionsControllerDependencies {
  commands: SubscriptionCommands;
  queries: SubscriptionQueries;
  billing: RunBillingCycleUseCase;
}

/** Routes for the authenticated user: `/api/v1/subscriptions`. */
export function subscriptionRoutes(deps: SubscriptionsControllerDependencies): Router {
  const router = Router();

  router.get(
    '/plans',
    endpoint({}, () =>
      Promise.resolve({ status: 200, body: { items: deps.queries.listPlans().map(presentPlan) } }),
    ),
  );

  router.post(
    '/',
    endpoint({ body: PurchaseBody }, async ({ body, actor }) => ({
      status: 201,
      body: presentSubscription(
        await deps.commands.purchase({
          actor,
          tier: body.tier,
          billingCycle: body.billingCycle,
          autoRenew: body.autoRenew,
        }),
      ),
    })),
  );

  router.get(
    '/',
    endpoint({ query: ListQuery }, async ({ query, actor }) => {
      const page = await deps.queries.listOwn(
        actor,
        query.status !== undefined ? { status: query.status } : {},
        toPageRequest(query),
      );
      return {
        status: 200,
        body: {
          items: page.items.map(presentSubscription),
          nextCursor: encodeCursor(page.nextCursor),
        },
      };
    }),
  );

  router.get(
    '/:subscriptionId',
    endpoint({ params: SubscriptionParams }, async ({ params, actor }) => ({
      status: 200,
      body: presentSubscription(await deps.queries.get(actor, params.subscriptionId)),
    })),
  );

  router.patch(
    '/:subscriptionId',
    endpoint({ params: SubscriptionParams, body: UpdateBody }, async ({ params, body, actor }) => ({
      status: 200,
      body: presentSubscription(
        await deps.commands.setAutoRenew(actor, params.subscriptionId, body.autoRenew),
      ),
    })),
  );

  router.post(
    '/:subscriptionId/cancel',
    endpoint({ params: SubscriptionParams }, async ({ params, actor }) => ({
      status: 200,
      body: presentSubscription(await deps.commands.cancel(actor, params.subscriptionId)),
    })),
  );

  return router;
}

/** Admin-only routes, mounted under `/api/v1/admin`. */
export function adminSubscriptionRoutes(deps: SubscriptionsControllerDependencies): Router {
  const router = Router();

  router.get(
    '/subscriptions',
    endpoint({ query: AdminListQuery }, async ({ query, actor }) => {
      const page = await deps.queries.listAll(
        actor,
        {
          ...(query.userId !== undefined ? { userId: query.userId } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
        },
        toPageRequest(query),
      );
      return {
        status: 200,
        body: {
          items: page.items.map(presentSubscription),
          nextCursor: encodeCursor(page.nextCursor),
        },
      };
    }),
  );

  router.post(
    '/billing/run',
    endpoint({}, async ({ actor }) => ({
      status: 200,
      body: await deps.billing.execute({ kind: 'admin', actor }),
    })),
  );

  return router;
}
