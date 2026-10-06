import type { ChargeOutcome } from '../../domain/entities/payment.js';

export interface ChargeRequest {
  /** Same key => same outcome; retries never charge twice. */
  idempotencyKey: string;
  userId: string;
  subscriptionId: string;
  amountCents: number;
  currency: string;
  description: string;
}

export interface PaymentGateway {
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}
