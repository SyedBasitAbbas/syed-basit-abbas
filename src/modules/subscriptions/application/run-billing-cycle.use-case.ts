import type { IdGenerator, UnitOfWork } from '../../../shared/application/ports.js';
import type { Actor } from '../../../shared/domain/actor.js';
import type { Clock } from '../../../shared/domain/clock.js';
import { ForbiddenError } from '../../../shared/domain/errors.js';
import { recordPayment } from '../domain/entities/payment.js';
import type { Subscription } from '../domain/entities/subscription.js';
import { SubscriptionPolicy } from '../domain/policies/subscription.policy.js';
import { addBillingCycle } from '../domain/services/plan-catalog.js';
import type { PaymentGateway } from './ports/payment-gateway.port.js';
import type { SubscriptionTransaction } from './subscription-commands.js';

export type BillingTrigger = { kind: 'scheduler' } | { kind: 'admin'; actor: Actor };

export interface BillingRunReport {
  processed: number;
  renewed: number;
  paymentFailed: number;
  expired: number;
}

type Outcome = 'renewed' | 'payment_failed' | 'expired';

/**
 * Billing simulation. For every active subscription whose cycle has ended:
 * - auto-renew on  -> charge; success starts the next cycle, failure deactivates;
 * - auto-renew off -> the subscription expires.
 * Each subscription is settled in its own short transaction with
 * `FOR UPDATE SKIP LOCKED`, so concurrent workers never double-bill.
 */
export class RunBillingCycleUseCase {
  constructor(
    private readonly deps: {
      uow: UnitOfWork<SubscriptionTransaction>;
      payments: PaymentGateway;
      clock: Clock;
      ids: IdGenerator;
      maxPerRun: number;
    },
  ) {}

  async execute(trigger: BillingTrigger): Promise<BillingRunReport> {
    if (trigger.kind === 'admin' && !SubscriptionPolicy.canRunBilling(trigger.actor)) {
      throw new ForbiddenError('Only administrators can trigger billing.');
    }
    const report: BillingRunReport = { processed: 0, renewed: 0, paymentFailed: 0, expired: 0 };
    while (report.processed < this.deps.maxPerRun) {
      const outcome = await this.settleNext();
      if (outcome === null) break;
      report.processed += 1;
      if (outcome === 'renewed') report.renewed += 1;
      if (outcome === 'payment_failed') report.paymentFailed += 1;
      if (outcome === 'expired') report.expired += 1;
    }
    return report;
  }

  private settleNext(): Promise<Outcome | null> {
    return this.deps.uow.run(async ({ subscriptions, payments }) => {
      const now = this.deps.clock.now();
      const subscription = await subscriptions.claimNextDueForBilling(now);
      if (!subscription) return null;

      if (subscription.billingActionAt(now) === 'expire') {
        subscription.expire(now);
        await subscriptions.save(subscription);
        return 'expired';
      }

      const outcome = await this.renew(subscription, now, payments);
      await subscriptions.save(subscription);
      return outcome;
    });
  }

  private async renew(
    subscription: Subscription,
    now: Date,
    payments: SubscriptionTransaction['payments'],
  ): Promise<Outcome> {
    const endingCycle = subscription.toSnapshot();
    const outcome = await this.deps.payments.charge({
      idempotencyKey: `renewal:${subscription.id}:${endingCycle.endDate.toISOString()}`,
      userId: subscription.userId,
      subscriptionId: subscription.id,
      amountCents: subscription.priceCents,
      currency: subscription.currency,
      description: `${endingCycle.tier} (${endingCycle.billingCycle}) renewal`,
    });

    // The payment always records the cycle it was meant to pay for.
    let periodStart = endingCycle.endDate;
    let periodEnd = addBillingCycle(endingCycle.endDate, endingCycle.billingCycle);
    if (outcome.status === 'succeeded') {
      subscription.renew(now);
      ({ startDate: periodStart, endDate: periodEnd } = subscription.toSnapshot());
    } else {
      subscription.markPaymentFailed(now);
    }

    await payments.insert(
      recordPayment({
        id: this.deps.ids.next(),
        subscription,
        kind: 'renewal',
        outcome,
        periodStart,
        periodEnd,
        now,
      }),
    );
    return outcome.status === 'succeeded' ? 'renewed' : 'payment_failed';
  }
}
