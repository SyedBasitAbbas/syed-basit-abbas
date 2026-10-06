import { Router } from 'express';
import { z } from 'zod';
import { endpoint } from '../../../shared/infrastructure/http/endpoint.js';
import { sanitizeText } from '../../../shared/infrastructure/http/sanitize.js';
import {
  encodeCursor,
  PageQuery,
  pageQueryShape,
  toPageRequest,
} from '../../../shared/infrastructure/http/schemas.js';
import type { AskQuestionUseCase } from '../application/ask-question.use-case.js';
import type { ChatQueries } from '../application/chat-queries.js';
import type { ChatMessageProps } from '../domain/entities/chat-message.js';
import { QUESTION_MAX_LENGTH } from '../domain/entities/question.js';
import type { QuotaSnapshot } from '../domain/services/quota.service.js';

const AskQuestionBody = z.strictObject({
  question: z
    .string()
    .min(1)
    .max(QUESTION_MAX_LENGTH)
    .transform(sanitizeText)
    .pipe(z.string().min(1, 'Question is empty once markup is removed.').max(QUESTION_MAX_LENGTH)),
});

const MessageParams = z.strictObject({ messageId: z.uuid() });
const UserParams = z.strictObject({ userId: z.uuid() });
const AdminMessagesQuery = z.strictObject({ ...pageQueryShape, userId: z.uuid().optional() });

export function presentMessage(message: Readonly<ChatMessageProps>) {
  return {
    id: message.id,
    userId: message.userId,
    question: message.question,
    answer: message.answer,
    status: message.status,
    model: message.model,
    usage: message.tokenUsage,
    charge: {
      source: message.charge.source,
      subscriptionId: message.charge.subscriptionId,
      periodStart: message.charge.periodStart.toISOString(),
    },
    providerResponseId: message.providerResponseId,
    latencyMs: message.latencyMs,
    failureCode: message.failureCode,
    requestId: message.requestId,
    createdAt: message.createdAt.toISOString(),
    completedAt: message.completedAt?.toISOString() ?? null,
  };
}

export function presentQuota(snapshot: QuotaSnapshot) {
  return {
    period: snapshot.period,
    free: { ...snapshot.free, resetsAt: snapshot.free.resetsAt.toISOString() },
    bundles: snapshot.bundles.map((bundle) => ({
      ...bundle,
      periodEnd: bundle.periodEnd.toISOString(),
    })),
    totalRemaining: snapshot.totalRemaining,
    unlimited: snapshot.totalRemaining === null,
    nextCharge: snapshot.nextCharge,
  };
}

export interface ChatControllerDependencies {
  ask: AskQuestionUseCase;
  queries: ChatQueries;
}

/** Routes for the authenticated user: `/api/v1/chat`. */
export function chatRoutes(deps: ChatControllerDependencies): Router {
  const router = Router();

  router.post(
    '/messages',
    endpoint({ body: AskQuestionBody }, async ({ body, actor, requestId, signal }) => {
      const result = await deps.ask.execute({ actor, question: body.question, requestId, signal });
      return {
        status: 201,
        body: {
          message: presentMessage(result.message),
          quota: {
            source: result.message.charge.source,
            subscriptionId: result.message.charge.subscriptionId,
            remainingInSource: result.remainingInSource,
          },
        },
      };
    }),
  );

  router.get(
    '/messages',
    endpoint({ query: PageQuery }, async ({ query, actor }) => {
      const page = await deps.queries.listOwnMessages(actor, toPageRequest(query));
      return {
        status: 200,
        body: { items: page.items.map(presentMessage), nextCursor: encodeCursor(page.nextCursor) },
      };
    }),
  );

  router.get(
    '/messages/:messageId',
    endpoint({ params: MessageParams }, async ({ params, actor }) => ({
      status: 200,
      body: presentMessage(await deps.queries.getMessage(actor, params.messageId)),
    })),
  );

  router.get(
    '/usage',
    endpoint({}, async ({ actor }) => ({
      status: 200,
      body: presentQuota(await deps.queries.getUsage(actor)),
    })),
  );

  return router;
}

/** Admin-only routes, mounted under `/api/v1/admin`. */
export function adminChatRoutes(deps: ChatControllerDependencies): Router {
  const router = Router();

  router.get(
    '/chat/messages',
    endpoint({ query: AdminMessagesQuery }, async ({ query, actor }) => {
      const page = await deps.queries.listAllMessages(
        actor,
        query.userId !== undefined ? { userId: query.userId } : {},
        toPageRequest(query),
      );
      return {
        status: 200,
        body: { items: page.items.map(presentMessage), nextCursor: encodeCursor(page.nextCursor) },
      };
    }),
  );

  router.get(
    '/users/:userId/usage',
    endpoint({ params: UserParams }, async ({ params, actor }) => ({
      status: 200,
      body: presentQuota(await deps.queries.getUsage(actor, params.userId)),
    })),
  );

  return router;
}
