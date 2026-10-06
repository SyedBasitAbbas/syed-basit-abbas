export type PaymentKind = 'initial' | 'renewal';
export type PaymentStatus = 'succeeded' | 'failed';

/** Immutable record of one simulated charge. Kept forever as billing history. */
export interface Payment {
  readonly id: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly kind: PaymentKind;
  readonly amountCents: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly failureReason: string | null;
  readonly providerReference: string | null;
  /** The billing cycle this charge pays for. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly createdAt: Date;
}

export type ChargeOutcome =
  { status: 'succeeded'; providerReference: string } | { status: 'failed'; reason: string };

/** Builds the billing record of one charge attempt for a subscription's cycle. */
export function recordPayment(input: {
  id: string;
  subscription: { id: string; userId: string; priceCents: number; currency: string };
  kind: PaymentKind;
  outcome: ChargeOutcome;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): Payment {
  const { subscription, outcome } = input;
  return {
    id: input.id,
    subscriptionId: subscription.id,
    userId: subscription.userId,
    kind: input.kind,
    amountCents: subscription.priceCents,
    currency: subscription.currency,
    status: outcome.status,
    failureReason: outcome.status === 'failed' ? outcome.reason : null,
    providerReference: outcome.status === 'succeeded' ? outcome.providerReference : null,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    createdAt: input.now,
  };
}
