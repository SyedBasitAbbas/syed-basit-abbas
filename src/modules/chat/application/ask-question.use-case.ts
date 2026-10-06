import type { IdGenerator, UnitOfWork } from '../../../shared/application/ports.js';
import type { Actor } from '../../../shared/domain/actor.js';
import { startOfUtcMonth } from '../../../shared/domain/calendar.js';
import type { Clock } from '../../../shared/domain/clock.js';
import { AppError, ForbiddenError, isAppError } from '../../../shared/domain/errors.js';
import {
  ChatMessage,
  type ChatMessageProps,
  type CompletionResult,
  type QuotaCharge,
} from '../domain/entities/chat-message.js';
import { Question } from '../domain/entities/question.js';
import { ChatPolicy } from '../domain/policies/chat.policy.js';
import { decideQuotaSource, type QuotaDecision } from '../domain/services/quota.service.js';
import type { ChatMessageRepository } from '../repositories/chat-message.repository.js';
import type { QuotaRepository } from '../repositories/quota.repository.js';
import type { AiCompletionPort } from './ports/ai-completion.port.js';

export interface ChatTransaction {
  quota: QuotaRepository;
  messages: ChatMessageRepository;
}

export interface AskQuestionDependencies {
  uow: UnitOfWork<ChatTransaction>;
  messages: ChatMessageRepository;
  ai: AiCompletionPort;
  clock: Clock;
  ids: IdGenerator;
  freeMessagesPerMonth: number;
}

export interface AskQuestionCommand {
  actor: Actor;
  question: string;
  requestId: string;
  signal: AbortSignal;
}

export interface AskQuestionResult {
  message: Readonly<ChatMessageProps>;
  /** Messages left in the quota this message was charged to; `null` = unlimited. */
  remainingInSource: number | null;
}

interface Reservation {
  message: ChatMessage;
  remainingInSource: number | null;
}

/**
 * Reserve -> call provider -> settle.
 *
 * 1. One short transaction takes the user's quota lock, lets the domain service
 *    pick the source, deducts one unit with a guarded atomic update and stores
 *    the message as `pending`.
 * 2. The slow AI call runs outside any transaction, so no lock or pooled
 *    connection is held while waiting on the provider.
 * 3. Success stores the answer and token usage. Failure, cancellation or a
 *    timeout marks the message `failed` and refunds the unit.
 *
 * Settling only succeeds while the message is still `pending`, so a refund can
 * never happen twice (for example here and in the abandoned-reservation reaper).
 */
export class AskQuestionUseCase {
  constructor(private readonly deps: AskQuestionDependencies) {}

  async execute(command: AskQuestionCommand): Promise<AskQuestionResult> {
    if (!ChatPolicy.canAsk(command.actor)) {
      throw new ForbiddenError('Your role is not allowed to use the chat.');
    }
    const question = Question.create(command.question);
    const { message, remainingInSource } = await this.reserve(command, question);

    let result: CompletionResult;
    try {
      result = await this.deps.ai.complete(
        { question: question.value, userId: command.actor.userId },
        { signal: command.signal },
      );
    } catch (error) {
      return this.failAndRefund(message, this.toFailure(error, command.signal));
    }
    if (command.signal.aborted) {
      // The client was already told the request timed out: do not charge it.
      return this.failAndRefund(message, this.toFailure(undefined, command.signal));
    }

    message.complete(result, this.deps.clock.now());
    if (!(await this.deps.messages.settle(message))) {
      throw new AppError('REQUEST_TIMEOUT', 'The request expired before the answer was stored.');
    }
    return { message: message.toSnapshot(), remainingInSource };
  }

  private reserve(command: AskQuestionCommand, question: Question): Promise<Reservation> {
    const { actor } = command;
    const now = this.deps.clock.now();
    return this.deps.uow.run(async ({ quota, messages }) => {
      const free = await quota.lockQuota(
        actor.userId,
        startOfUtcMonth(now),
        this.deps.freeMessagesPerMonth,
      );
      const bundles = await quota.findActiveBundles(actor.userId, now, { lock: true });
      const decision = decideQuotaSource(free, bundles, now);
      const { charge, remainingInSource } = await this.consume(quota, actor.userId, decision);

      const message = ChatMessage.reserve({
        id: this.deps.ids.next(),
        userId: actor.userId,
        question,
        charge,
        requestId: command.requestId,
        now,
      });
      await messages.insert(message);
      return { message, remainingInSource };
    });
  }

  private async consume(
    quota: QuotaRepository,
    userId: string,
    decision: QuotaDecision,
  ): Promise<{ charge: QuotaCharge; remainingInSource: number | null }> {
    if (decision.source === 'free') {
      const { usage } = decision;
      usage.consume();
      await quota.consumeFree(userId, usage.periodStart);
      return {
        charge: { source: 'free', subscriptionId: null, periodStart: usage.periodStart },
        remainingInSource: usage.remaining,
      };
    }
    const { allowance } = decision;
    allowance.consume();
    await quota.consumeBundle(
      allowance.subscriptionId,
      allowance.periodStart,
      allowance.maxMessages,
    );
    return {
      charge: {
        source: 'subscription',
        subscriptionId: allowance.subscriptionId,
        periodStart: allowance.periodStart,
      },
      remainingInSource: allowance.remaining,
    };
  }

  private async failAndRefund(message: ChatMessage, failure: AppError): Promise<never> {
    message.fail(failure.code, this.deps.clock.now());
    await this.deps.uow.run(async ({ quota, messages }) => {
      if (await messages.settle(message)) {
        await quota.refund(message.userId, message.charge);
      }
    });
    throw failure;
  }

  private toFailure(error: unknown, signal: AbortSignal): AppError {
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      return isAppError(reason)
        ? reason
        : new AppError('REQUEST_TIMEOUT', 'The request was cancelled before the AI answered.');
    }
    if (isAppError(error)) return error;
    return new AppError(
      'AI_PROVIDER_UNAVAILABLE',
      'The AI provider failed to answer. Your quota was not charged.',
      undefined,
      { cause: error },
    );
  }
}
