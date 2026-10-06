import type { Question } from './question.js';

export type ChatMessageStatus = 'pending' | 'completed' | 'failed';
export type QuotaSource = 'free' | 'subscription';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Which quota paid for a message, and in which period it was counted. */
export interface QuotaCharge {
  source: QuotaSource;
  subscriptionId: string | null;
  /** Calendar month start (free) or billing cycle start (subscription). */
  periodStart: Date;
}

export interface ChatMessageProps {
  id: string;
  userId: string;
  question: string;
  answer: string | null;
  status: ChatMessageStatus;
  charge: QuotaCharge;
  tokenUsage: TokenUsage | null;
  model: string | null;
  providerResponseId: string | null;
  latencyMs: number | null;
  failureCode: string | null;
  /** Request metadata. */
  requestId: string;
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompletionResult {
  answer: string;
  tokenUsage: TokenUsage;
  model: string;
  providerResponseId: string;
  latencyMs: number;
}

/**
 * One question/answer exchange. Created as `pending` when its quota unit is
 * reserved, then either `completed` with the AI answer or `failed` (and the
 * reserved unit is refunded).
 */
export class ChatMessage {
  private constructor(private props: ChatMessageProps) {}

  static reserve(input: {
    id: string;
    userId: string;
    question: Question;
    charge: QuotaCharge;
    requestId: string;
    now: Date;
  }): ChatMessage {
    if ((input.charge.source === 'subscription') !== (input.charge.subscriptionId !== null)) {
      throw new Error('Invariant violated: subscription charges need a subscription id');
    }
    return new ChatMessage({
      id: input.id,
      userId: input.userId,
      question: input.question.value,
      answer: null,
      status: 'pending',
      charge: { ...input.charge },
      tokenUsage: null,
      model: null,
      providerResponseId: null,
      latencyMs: null,
      failureCode: null,
      requestId: input.requestId,
      createdAt: input.now,
      completedAt: null,
    });
  }

  static rehydrate(props: ChatMessageProps): ChatMessage {
    return new ChatMessage({ ...props });
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get status(): ChatMessageStatus {
    return this.props.status;
  }

  get charge(): QuotaCharge {
    return this.props.charge;
  }

  complete(result: CompletionResult, now: Date): void {
    this.assertPending();
    const { promptTokens, completionTokens, totalTokens } = result.tokenUsage;
    if (
      [promptTokens, completionTokens, totalTokens].some((n) => !Number.isInteger(n) || n < 0) ||
      totalTokens !== promptTokens + completionTokens
    ) {
      throw new Error('Invariant violated: inconsistent token usage');
    }
    this.props.status = 'completed';
    this.props.answer = result.answer;
    this.props.tokenUsage = { ...result.tokenUsage };
    this.props.model = result.model;
    this.props.providerResponseId = result.providerResponseId;
    this.props.latencyMs = result.latencyMs;
    this.props.completedAt = now;
  }

  fail(failureCode: string, now: Date): void {
    this.assertPending();
    this.props.status = 'failed';
    this.props.failureCode = failureCode;
    this.props.completedAt = now;
  }

  toSnapshot(): Readonly<ChatMessageProps> {
    return { ...this.props, charge: { ...this.props.charge } };
  }

  private assertPending(): void {
    if (this.props.status !== 'pending') {
      throw new Error(
        `Invariant violated: message ${this.props.id} is already ${this.props.status}`,
      );
    }
  }
}
