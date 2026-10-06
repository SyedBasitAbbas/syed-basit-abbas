import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChargeRequest, PaymentGateway } from '../application/ports/payment-gateway.port.js';
import type { ChargeOutcome } from '../domain/entities/payment.js';

const DECLINE_REASONS = ['card_declined', 'insufficient_funds', 'processing_error'] as const;
const IDEMPOTENCY_MEMORY = 10_000;

/**
 * Payment processor simulation: random declines at a configurable rate,
 * small latency, and idempotency keys (a retried charge returns the first result).
 */
export class SimulatedPaymentGateway implements PaymentGateway {
  private readonly results = new Map<string, ChargeOutcome>();
  private readonly random: () => number;

  constructor(
    private readonly options: { failureRate: number; latencyMs?: number; random?: () => number },
  ) {
    this.random = options.random ?? Math.random;
  }

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    const previous = this.results.get(request.idempotencyKey);
    if (previous) return previous;

    await sleep(this.options.latencyMs ?? 25);
    const result: ChargeOutcome =
      this.random() < this.options.failureRate
        ? {
            status: 'failed',
            reason:
              DECLINE_REASONS[Math.floor(this.random() * DECLINE_REASONS.length)] ??
              'card_declined',
          }
        : { status: 'succeeded', providerReference: `sim_${randomUUID()}` };

    if (this.results.size >= IDEMPOTENCY_MEMORY) this.results.clear();
    this.results.set(request.idempotencyKey, result);
    return result;
  }
}
