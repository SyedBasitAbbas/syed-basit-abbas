import type { Page, PageRequest } from '../../../shared/application/pagination.js';
import type { Actor } from '../../../shared/domain/actor.js';
import { startOfUtcMonth } from '../../../shared/domain/calendar.js';
import type { Clock } from '../../../shared/domain/clock.js';
import { ForbiddenError, NotFoundError } from '../../../shared/domain/errors.js';
import type { ChatMessageProps } from '../domain/entities/chat-message.js';
import { ChatPolicy } from '../domain/policies/chat.policy.js';
import { buildQuotaSnapshot, type QuotaSnapshot } from '../domain/services/quota.service.js';
import type { ChatMessageRepository } from '../repositories/chat-message.repository.js';
import type { QuotaRepository } from '../repositories/quota.repository.js';

export interface ChatQueriesDependencies {
  messages: ChatMessageRepository;
  quota: QuotaRepository;
  clock: Clock;
  freeMessagesPerMonth: number;
}

export class ChatQueries {
  constructor(private readonly deps: ChatQueriesDependencies) {}

  async getMessage(actor: Actor, messageId: string): Promise<Readonly<ChatMessageProps>> {
    const message = await this.deps.messages.findById(messageId);
    // Someone else's message is reported as missing so ids cannot be probed.
    if (!message || !ChatPolicy.canRead(actor, message)) {
      throw new NotFoundError('Chat message');
    }
    return message.toSnapshot();
  }

  async listOwnMessages(
    actor: Actor,
    page: PageRequest,
  ): Promise<Page<Readonly<ChatMessageProps>>> {
    const result = await this.deps.messages.list({ userId: actor.userId }, page);
    return { items: result.items.map((m) => m.toSnapshot()), nextCursor: result.nextCursor };
  }

  async listAllMessages(
    actor: Actor,
    filter: { userId?: string },
    page: PageRequest,
  ): Promise<Page<Readonly<ChatMessageProps>>> {
    if (!ChatPolicy.canListAll(actor)) {
      throw new ForbiddenError('Only administrators can list all chat messages.');
    }
    const result = await this.deps.messages.list(filter, page);
    return { items: result.items.map((m) => m.toSnapshot()), nextCursor: result.nextCursor };
  }

  async getUsage(actor: Actor, userId: string = actor.userId): Promise<QuotaSnapshot> {
    if (!ChatPolicy.canReadUsageOf(actor, userId)) {
      throw new ForbiddenError('You can only read your own usage.');
    }
    const now = this.deps.clock.now();
    const free = await this.deps.quota.readFreeUsage(
      userId,
      startOfUtcMonth(now),
      this.deps.freeMessagesPerMonth,
    );
    const bundles = await this.deps.quota.findActiveBundles(userId, now, { lock: false });
    return buildQuotaSnapshot(free, bundles, now);
  }
}
