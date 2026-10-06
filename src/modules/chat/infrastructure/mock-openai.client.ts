import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '../../../shared/domain/errors.js';
import { sanitizeText } from '../../../shared/infrastructure/http/sanitize.js';
import type { CompletionResult } from '../domain/entities/chat-message.js';
import type {
  AiCompletionPort,
  AiCompletionRequest,
} from '../application/ports/ai-completion.port.js';

/** Shape of an OpenAI Chat Completions response (the fields we use). */
export interface OpenAiChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface MockOpenAiOptions {
  minLatencyMs: number;
  maxLatencyMs: number;
  failureRate: number;
  model?: string;
  random?: () => number;
}

const SYSTEM_PROMPT_TOKENS = 18;

/** Rough OpenAI-style token estimate (~4 characters per token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Stand-in for the OpenAI API: waits a random, configurable latency (cancellable
 * through the abort signal), can fail randomly, and returns an OpenAI-shaped
 * completion with token usage. Swapping in the real client only means
 * implementing `AiCompletionPort` with the official SDK.
 */
export class MockOpenAiChatClient implements AiCompletionPort {
  private readonly model: string;
  private readonly random: () => number;

  constructor(private readonly options: MockOpenAiOptions) {
    this.model = options.model ?? 'gpt-4o-mini (mock)';
    this.random = options.random ?? Math.random;
  }

  async complete(
    request: AiCompletionRequest,
    { signal }: { signal: AbortSignal },
  ): Promise<CompletionResult> {
    const started = performance.now();
    const { minLatencyMs, maxLatencyMs } = this.options;
    const latency = Math.round(minLatencyMs + this.random() * (maxLatencyMs - minLatencyMs));
    await sleep(latency, undefined, { signal });

    if (this.random() < this.options.failureRate) {
      throw new AppError('AI_PROVIDER_UNAVAILABLE', 'The AI provider is temporarily unavailable.');
    }

    const response = this.buildResponse(request.question);
    const choice = response.choices[0];
    if (!choice)
      throw new AppError('AI_PROVIDER_UNAVAILABLE', 'The AI provider returned no answer.');
    return {
      // Model output is untrusted input too.
      answer: sanitizeText(choice.message.content),
      tokenUsage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      model: response.model,
      providerResponseId: response.id,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  private buildResponse(question: string): OpenAiChatCompletion {
    const preview = question.length > 160 ? `${question.slice(0, 157)}...` : question;
    const content =
      `This is a simulated answer to: "${preview}". ` +
      'In production this request is sent to the OpenAI Chat Completions API; here the ' +
      'response, its latency and its token usage are mocked.';
    const promptTokens = SYSTEM_PROMPT_TOKENS + estimateTokens(question);
    const completionTokens = estimateTokens(content);
    return {
      id: `chatcmpl-mock-${randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }
}
