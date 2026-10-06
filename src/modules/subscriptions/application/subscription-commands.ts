import type { IdGenerator, UnitOfWork } from '../../../shared/application/ports.js';
import type { Actor } from '../../../shared/domain/actor.js';
import type { Clock } from '../../../shared/domain/clock.js';
import {
  ForbiddenError,
  NotFoundError,
  PaymentFailedError,
} from '../../../shared/domain/errors.js';
import { recordPayment } from '../domain/entities/payment.js';
import { Subscription } from '../domain/entities/subscription.js';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy.js';
import type { BillingCycle, SubscriptionTier } from '../domain/services/plan-catalog.js';
import type {
  PaymentRepository,
  SubscriptionRepository,
  SubscriptionView,
} from '../repositories/subscription.repository.js';
import type { PaymentGateway } from './ports/payment-gateway.port.js';

export interface SubscriptionTransaction {
  subscriptions: SubscriptionRepository;
  payments: PaymentRepository;
}

export interface SubscriptionCommandsDependencies {
  uow: UnitOfWork<SubscriptionTransaction>;
  subscriptions: SubscriptionRepository;
  payments: PaymentGateway;
  clock: Clock;
  ids: IdGenerator;
}

export interface PurchaseCommand {
  actor: Actor;
  tier: SubscriptionTier;
  billingCycle: BillingCycle;
  autoRenew: boolean;
}

export class SubscriptionCommands {
  constructor(private readonly deps: SubscriptionCommandsDependencies) {}

  /**
   * Buys a bundle for the acting user and charges the first cycle up front.
   * The charge, the subscription and its payment record share one transaction
   * (as renewals do), so they are stored together or not at all. A declined
   * payment still stores the inactive subscription and the failed payment for
   * the audit trail, then reports a typed PAYMENT_FAILED error.
   */
  async purchase(command: PurchaseCommand): Promise<SubscriptionView> {
    if (!SubscriptionPolicy.canPurchase(command.actor)) {
      throw new ForbiddenError('Your role is not allowed to buy subscriptions.');
    }
    const subscriptionId = this.deps.ids.next();
    const now = this.deps.clock.now();

    const { subscription, payment } = await this.deps.uow.run(
      async ({ subscriptions, payments }) => {
        const created = Subscription.create({
          id: subscriptionId,
          userId: command.actor.userId,
          tier: command.tier,
          billingCycle: command.billingCycle,
          autoRenew: command.autoRenew,
          now,
        });
        const outcome = await this.deps.payments.charge({
          idempotencyKey: `initial:${subscriptionId}`,
          userId: created.userId,
          subscriptionId,
          amountCents: created.priceCents,
          currency: created.currency,
          description: `${command.tier} (${command.billingCycle}) subscription`,
        });
        if (outcome.status === 'failed') created.markPaymentFailed(now);

        const record = recordPayment({
          id: this.deps.ids.next(),
          subscription: created,
          kind: 'initial',
          outcome,
          periodStart: created.startDate,
          periodEnd: created.endDate,
          now,
        });
        await subscriptions.insert(created);
        await payments.insert(record);
        return { subscription: created.toSnapshot(), payment: record };
      },
    );

    if (payment.status === 'failed') {
      throw new PaymentFailedError({
        subscriptionId,
        paymentId: payment.id,
        reason: payment.failureReason ?? 'declined',
      });
    }
    return { subscription, usage: { used: 0, remaining: subscription.maxMessages } };
  }

  async setAutoRenew(
    actor: Actor,
    subscriptionId: string,
    autoRenew: boolean,
  ): Promise<SubscriptionView> {
    await this.mutate(actor, subscriptionId, (subscription, now) => {
      subscription.setAutoRenew(autoRenew, now);
    });
    return this.view(subscriptionId);
  }

  async cancel(actor: Actor, subscriptionId: string): Promise<SubscriptionView> {
    await this.mutate(actor, subscriptionId, (subscription, now) => {
      subscription.cancel(now);
    });
    return this.view(subscriptionId);
  }

  private async mutate(
    actor: Actor,
    subscriptionId: string,
    change: (subscription: Subscription, now: Date) => void,
  ): Promise<void> {
    await this.deps.uow.run(async ({ subscriptions }) => {
      const subscription = await subscriptions.findById(subscriptionId, { forUpdate: true });
      if (!subscription || !SubscriptionPolicy.canView(actor, subscription)) {
        throw new NotFoundError('Subscription');
      }
      if (!SubscriptionPolicy.canManage(actor, subscription)) {
        throw new ForbiddenError('You cannot manage this subscription.');
      }
      change(subscription, this.deps.clock.now());
      await subscriptions.save(subscription);
    });
  }

  private async view(subscriptionId: string): Promise<SubscriptionView> {
    const view = await this.deps.subscriptions.findViewById(subscriptionId);
    if (!view) throw new NotFoundError('Subscription');
    return view;
  }
}
