import type { CompletionResult } from '../../domain/entities/chat-message.js';

export interface AiCompletionRequest {
  question: string;
  userId: string;
}

/** Port to the LLM provider (OpenAI in production, a latency-simulating mock here). */
export interface AiCompletionPort {
  complete(
    request: AiCompletionRequest,
    options: { signal: AbortSignal },
  ): Promise<CompletionResult>;
}
