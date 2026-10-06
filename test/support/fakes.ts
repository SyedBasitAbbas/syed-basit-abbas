import type { CompletionResult } from '../../src/modules/chat/domain/entities/chat-message.js';
import type { AiCompletionPort } from '../../src/modules/chat/application/ports/ai-completion.port.js';
import type {
  ChargeRequest,
  PaymentGateway,
} from '../../src/modules/subscriptions/application/ports/payment-gateway.port.js';
import type { ChargeOutcome } from '../../src/modules/subscriptions/domain/entities/payment.js';
import type { Clock } from '../../src/shared/domain/clock.js';

/** Business clock that tests can move (auth always uses real time). */
export class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  set(date: Date | string): void {
    this.current = new Date(date);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Payment gateway whose outcomes are scripted per call (default: success). */
export class ScriptedPaymentGateway implements PaymentGateway {
  readonly charges: ChargeRequest[] = [];
  private readonly script: ('succeed' | 'fail')[] = [];

  failNext(times = 1): void {
    for (let i = 0; i < times; i += 1) this.script.push('fail');
  }

  charge(request: ChargeRequest): Promise<ChargeOutcome> {
    this.charges.push(request);
    const next = this.script.shift() ?? 'succeed';
    return Promise.resolve(
      next === 'succeed'
        ? { status: 'succeeded', providerReference: `test_${this.charges.length}` }
        : { status: 'failed', reason: 'card_declined' },
    );
  }
}

/** AI provider stub that always fails. */
export const failingAi: AiCompletionPort = {
  complete: () => Promise.reject(new Error('upstream exploded')),
};

/** AI provider stub that answers after `delayMs` unless aborted. */
export function slowAi(delayMs: number): AiCompletionPort {
  return {
    complete: (_request, { signal }) =>
      new Promise<CompletionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            answer: 'late answer',
            tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'slow-mock',
            providerResponseId: 'slow-1',
            latencyMs: delayMs,
          });
        }, delayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        });
      }),
  };
}

/** AI provider stub that answers after `delayMs` and ignores cancellation. */
export function stubbornAi(delayMs: number): AiCompletionPort {
  return {
    complete: () =>
      new Promise<CompletionResult>((resolve) => {
        setTimeout(() => {
          resolve({
            answer: 'answer that arrived too late',
            tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            model: 'stubborn-mock',
            providerResponseId: 'stubborn-1',
            latencyMs: delayMs,
          });
        }, delayMs);
      }),
  };
}
