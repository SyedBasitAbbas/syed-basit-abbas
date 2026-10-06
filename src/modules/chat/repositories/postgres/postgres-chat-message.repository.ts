import { sql, type Selectable } from 'kysely';
import type { Page, PageRequest } from '../../../../shared/application/pagination.js';
import type { DbExecutor } from '../../../../shared/infrastructure/database/database.js';
import type { ChatMessagesTable } from '../../../../shared/infrastructure/database/schema.js';
import { ChatMessage } from '../../domain/entities/chat-message.js';
import type { ChatMessageFilter, ChatMessageRepository } from '../chat-message.repository.js';

type Row = Selectable<ChatMessagesTable>;

function toEntity(row: Row): ChatMessage {
  return ChatMessage.rehydrate({
    id: row.id,
    userId: row.user_id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    charge: {
      source: row.quota_source,
      subscriptionId: row.subscription_id,
      periodStart: row.quota_period_start,
    },
    tokenUsage:
      row.prompt_tokens !== null && row.completion_tokens !== null && row.total_tokens !== null
        ? {
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            totalTokens: row.total_tokens,
          }
        : null,
    model: row.model,
    providerResponseId: row.provider_response_id,
    latencyMs: row.latency_ms,
    failureCode: row.failure_code,
    requestId: row.request_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export class PostgresChatMessageRepository implements ChatMessageRepository {
  constructor(private readonly db: DbExecutor) {}

  async insert(message: ChatMessage): Promise<void> {
    const m = message.toSnapshot();
    await this.db
      .insertInto('chat_messages')
      .values({
        id: m.id,
        user_id: m.userId,
        question: m.question,
        answer: m.answer,
        status: m.status,
        quota_source: m.charge.source,
        subscription_id: m.charge.subscriptionId,
        quota_period_start: m.charge.periodStart,
        model: m.model,
        provider_response_id: m.providerResponseId,
        prompt_tokens: m.tokenUsage?.promptTokens ?? null,
        completion_tokens: m.tokenUsage?.completionTokens ?? null,
        total_tokens: m.tokenUsage?.totalTokens ?? null,
        latency_ms: m.latencyMs,
        failure_code: m.failureCode,
        request_id: m.requestId,
        created_at: m.createdAt,
        completed_at: m.completedAt,
      })
      .execute();
  }

  async settle(message: ChatMessage): Promise<boolean> {
    const m = message.toSnapshot();
    const result = await this.db
      .updateTable('chat_messages')
      .set({
        answer: m.answer,
        status: m.status,
        model: m.model,
        provider_response_id: m.providerResponseId,
        prompt_tokens: m.tokenUsage?.promptTokens ?? null,
        completion_tokens: m.tokenUsage?.completionTokens ?? null,
        total_tokens: m.tokenUsage?.totalTokens ?? null,
        latency_ms: m.latencyMs,
        failure_code: m.failureCode,
        completed_at: m.completedAt,
      })
      .where('id', '=', m.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async findById(id: string): Promise<ChatMessage | null> {
    const row = await this.db
      .selectFrom('chat_messages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toEntity(row) : null;
  }

  async list(filter: ChatMessageFilter, page: PageRequest): Promise<Page<ChatMessage>> {
    let query = this.db.selectFrom('chat_messages').selectAll();
    if (filter.userId !== undefined) query = query.where('user_id', '=', filter.userId);
    if (page.cursor) {
      const { createdAt, id } = page.cursor;
      query = query.where(sql<boolean>`(created_at, id) < (${createdAt}, ${id}::uuid)`);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const items = rows.slice(0, page.limit).map(toEntity);
    const last = rows.length > page.limit ? rows[page.limit - 1] : undefined;
    return { items, nextCursor: last ? { createdAt: last.created_at, id: last.id } : null };
  }
}
