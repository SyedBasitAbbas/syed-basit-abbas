import type { Page, PageRequest } from '../../../shared/application/pagination.js';
import type { ChatMessage } from '../domain/entities/chat-message.js';

export interface ChatMessageFilter {
  userId?: string;
}

export interface ChatMessageRepository {
  insert(message: ChatMessage): Promise<void>;
  /**
   * Persists the outcome of a pending message. Returns false when the message
   * was no longer pending (already settled elsewhere), in which case nothing changes.
   */
  settle(message: ChatMessage): Promise<boolean>;
  findById(id: string): Promise<ChatMessage | null>;
  list(filter: ChatMessageFilter, page: PageRequest): Promise<Page<ChatMessage>>;
}
