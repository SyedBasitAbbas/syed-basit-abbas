import type { Page, PageRequest } from '../../../shared/application/pagination.js';
import type { Payment } from '../domain/entities/payment.js';
import type {
  Subscription,
  SubscriptionProps,
  SubscriptionStatus,
} from '../domain/entities/subscription.js';

/** Read model: a subscription plus its usage in the current billing cycle. */
export interface SubscriptionView {
  subscription: Readonly<SubscriptionProps>;
  usage: { used: number; remaining: number | null };
}

export interface SubscriptionFilter {
  userId?: string;
  status?: SubscriptionStatus;
}

export interface SubscriptionRepository {
  insert(subscription: Subscription): Promise<void>;
  save(subscription: Subscription): Promise<void>;
  findById(id: string, options?: { forUpdate?: boolean }): Promise<Subscription | null>;
  findViewById(id: string): Promise<SubscriptionView | null>;
  list(filter: SubscriptionFilter, page: PageRequest): Promise<Page<SubscriptionView>>;
  /**
   * Locks and returns one active subscription whose cycle has ended, skipping
   * rows another worker already holds, so several instances can bill in parallel.
   */
  claimNextDueForBilling(now: Date): Promise<Subscription | null>;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
}
