import { SubscriptionNotActiveError } from '../../../../shared/domain/errors.js';
import {
  addBillingCycle,
  messageAllowance,
  PLAN_CATALOG,
  type BillingCycle,
  type SubscriptionTier,
} from '../services/plan-catalog.js';

export type SubscriptionStatus = 'active' | 'inactive';
export type InactiveReason = 'cancelled' | 'payment_failed' | 'expired';
export type BillingAction = 'none' | 'renew' | 'expire';

export interface SubscriptionProps {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  billingCycle: BillingCycle;
  /** Allowance per billing cycle; `null` = unlimited (Enterprise). */
  maxMessages: number | null;
  priceCents: number;
  currency: string;
  autoRenew: boolean;
  status: SubscriptionStatus;
  inactiveReason: InactiveReason | null;
  /** Start of the current billing cycle. */
  startDate: Date;
  /** End (exclusive) of the current billing cycle. */
  endDate: Date;
  /** When the next renewal is attempted; `null` when the subscription will not renew. */
  renewalDate: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSubscriptionInput {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  billingCycle: BillingCycle;
  autoRenew: boolean;
  now: Date;
}

/**
 * Subscription bundle aggregate. Owns the lifecycle rules:
 * purchase -> (renew | expire | payment failure | cancellation).
 * Message consumption is tracked per billing cycle by the chat module,
 * so renewing a cycle naturally starts a fresh allowance and every past
 * cycle's usage is preserved.
 */
export class Subscription {
  private constructor(private props: SubscriptionProps) {}

  static create(input: CreateSubscriptionInput): Subscription {
    const plan = PLAN_CATALOG[input.tier];
    const endDate = addBillingCycle(input.now, input.billingCycle);
    return new Subscription({
      id: input.id,
      userId: input.userId,
      tier: input.tier,
      billingCycle: input.billingCycle,
      maxMessages: messageAllowance(plan, input.billingCycle),
      priceCents: plan.priceCents[input.billingCycle],
      currency: plan.currency,
      autoRenew: input.autoRenew,
      status: 'active',
      inactiveReason: null,
      startDate: input.now,
      endDate,
      renewalDate: input.autoRenew ? endDate : null,
      cancelledAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(props: SubscriptionProps): Subscription {
    return new Subscription({ ...props });
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get status(): SubscriptionStatus {
    return this.props.status;
  }

  get priceCents(): number {
    return this.props.priceCents;
  }

  get currency(): string {
    return this.props.currency;
  }

  get startDate(): Date {
    return this.props.startDate;
  }

  get endDate(): Date {
    return this.props.endDate;
  }

  isActiveAt(now: Date): boolean {
    return (
      this.props.status === 'active' &&
      this.props.startDate.getTime() <= now.getTime() &&
      now.getTime() < this.props.endDate.getTime()
    );
  }

  setAutoRenew(enabled: boolean, now: Date): void {
    this.assertActive();
    this.props.autoRenew = enabled;
    this.props.renewalDate = enabled ? this.props.endDate : null;
    this.props.updatedAt = now;
  }

  /**
   * Cancellation ends the current billing cycle now, stops all future renewals
   * and keeps every historical record (usage rows and chat messages are untouched).
   * To stop at the end of the cycle instead, disable auto-renew.
   */
  cancel(now: Date): void {
    this.assertActive();
    this.props.status = 'inactive';
    this.props.inactiveReason = 'cancelled';
    this.props.cancelledAt = now;
    this.props.autoRenew = false;
    this.props.renewalDate = null;
    if (now.getTime() < this.props.endDate.getTime()) {
      this.props.endDate = new Date(Math.max(now.getTime(), this.props.startDate.getTime() + 1));
    }
    this.props.updatedAt = now;
  }

  /** What the billing job has to do with this subscription at `now`. */
  billingActionAt(now: Date): BillingAction {
    if (this.props.status !== 'active' || now.getTime() < this.props.endDate.getTime()) {
      return 'none';
    }
    return this.props.autoRenew ? 'renew' : 'expire';
  }

  /** Starts the next billing cycle after a successful renewal payment. */
  renew(now: Date): void {
    this.assertBillingAction(now, 'renew');
    let nextStart = this.props.endDate;
    let nextEnd = addBillingCycle(nextStart, this.props.billingCycle);
    if (nextEnd.getTime() <= now.getTime()) {
      // Billing was down for more than a whole cycle: start a fresh cycle now
      // instead of charging for periods that are already over.
      nextStart = now;
      nextEnd = addBillingCycle(now, this.props.billingCycle);
    }
    this.props.startDate = nextStart;
    this.props.endDate = nextEnd;
    this.props.renewalDate = nextEnd;
    this.props.updatedAt = now;
  }

  /** The (initial or renewal) payment was declined: the subscription becomes inactive. */
  markPaymentFailed(now: Date): void {
    this.assertActive();
    this.props.status = 'inactive';
    this.props.inactiveReason = 'payment_failed';
    this.props.autoRenew = false;
    this.props.renewalDate = null;
    this.props.updatedAt = now;
  }

  /** The cycle ended and auto-renew is off. */
  expire(now: Date): void {
    this.assertBillingAction(now, 'expire');
    this.props.status = 'inactive';
    this.props.inactiveReason = 'expired';
    this.props.renewalDate = null;
    this.props.updatedAt = now;
  }

  toSnapshot(): Readonly<SubscriptionProps> {
    return { ...this.props };
  }

  private assertActive(): void {
    if (this.props.status !== 'active') {
      throw new SubscriptionNotActiveError(this.props.id, this.props.status);
    }
  }

  private assertBillingAction(now: Date, expected: BillingAction): void {
    const action = this.billingActionAt(now);
    if (action !== expected) {
      throw new Error(
        `Invariant violated: subscription ${this.props.id} expected billing action "${expected}" but is "${action}"`,
      );
    }
  }
}
