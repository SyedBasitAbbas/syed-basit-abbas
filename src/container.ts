import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config/env.js';
import { GetSystemMetricsUseCase } from './modules/analytics/application/get-system-metrics.use-case.js';
import { PostgresMetricsRepository } from './modules/analytics/repositories/postgres/postgres-metrics.repository.js';
import {
  AskQuestionUseCase,
  type ChatTransaction,
} from './modules/chat/application/ask-question.use-case.js';
import { ChatQueries } from './modules/chat/application/chat-queries.js';
import { ReapAbandonedReservationsUseCase } from './modules/chat/application/reap-abandoned-reservations.use-case.js';
import type { AiCompletionPort } from './modules/chat/application/ports/ai-completion.port.js';
import { MockOpenAiChatClient } from './modules/chat/infrastructure/mock-openai.client.js';
import { PostgresChatMessageRepository } from './modules/chat/repositories/postgres/postgres-chat-message.repository.js';
import { PostgresQuotaRepository } from './modules/chat/repositories/postgres/postgres-quota.repository.js';
import {
  PostgresAuthSessionRepository,
  PostgresUserRepository,
} from './modules/identity/repositories/postgres/postgres-identity.repository.js';
import type { PaymentGateway } from './modules/subscriptions/application/ports/payment-gateway.port.js';
import { RunBillingCycleUseCase } from './modules/subscriptions/application/run-billing-cycle.use-case.js';
import {
  SubscriptionCommands,
  type SubscriptionTransaction,
} from './modules/subscriptions/application/subscription-commands.js';
import { SubscriptionQueries } from './modules/subscriptions/application/subscription-queries.js';
import { SimulatedPaymentGateway } from './modules/subscriptions/infrastructure/simulated-payment-gateway.js';
import {
  PostgresPaymentRepository,
  PostgresSubscriptionRepository,
} from './modules/subscriptions/repositories/postgres/postgres-subscription.repository.js';
import type { IdGenerator } from './shared/application/ports.js';
import { systemClock, type Clock } from './shared/domain/clock.js';
import {
  createDatabase,
  KyselyUnitOfWork,
  type Db,
} from './shared/infrastructure/database/database.js';
import {
  MemoryRateLimitStore,
  PostgresRateLimitStore,
  type RateLimitStore,
} from './shared/infrastructure/http/rate-limit.js';
import { BackgroundJobs } from './shared/infrastructure/jobs/background-jobs.js';
import { createLogger, type Logger } from './shared/infrastructure/logging/logger.js';
import type { AuthenticateDependencies } from './shared/infrastructure/security/authenticate.js';
import { DpopProofVerifier } from './shared/infrastructure/security/dpop-proof-verifier.js';
import { OidcAccessTokenVerifier } from './shared/infrastructure/security/oidc-token-verifier.js';
import { PostgresReplayCache } from './shared/infrastructure/security/replay-cache.js';

/** Upper bound of subscriptions settled per billing run (the rest wait for the next run). */
const BILLING_BATCH_LIMIT = 500;

export interface Container {
  config: AppConfig;
  logger: Logger;
  db: Db;
  clock: Clock;
  startedAt: Date;
  rateLimitStore: RateLimitStore;
  /** Milliseconds clock for rate-limit windows. */
  rateLimitClock: () => number;
  auth: AuthenticateDependencies;
  chat: { ask: AskQuestionUseCase; queries: ChatQueries; reaper: ReapAbandonedReservationsUseCase };
  subscriptions: {
    commands: SubscriptionCommands;
    queries: SubscriptionQueries;
    billing: RunBillingCycleUseCase;
  };
  analytics: { metrics: GetSystemMetricsUseCase };
  jobs: BackgroundJobs;
  close(): Promise<void>;
}

/** Test seams: anything external can be swapped, nothing can be bypassed. */
export interface ContainerOverrides {
  logger?: Logger;
  clock?: Clock;
  ai?: AiCompletionPort;
  payments?: PaymentGateway;
  rateLimitStore?: RateLimitStore;
  rateLimitClock?: () => number;
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger =
    overrides.logger ??
    createLogger({ level: config.logLevel, pretty: config.logFormat === 'pretty' });
  const db = createDatabase(config.database);
  const clock = overrides.clock ?? systemClock;
  const ids: IdGenerator = { next: () => randomUUID() };

  const chatUow = new KyselyUnitOfWork<ChatTransaction>(db, (trx) => ({
    quota: new PostgresQuotaRepository(trx),
    messages: new PostgresChatMessageRepository(trx),
  }));
  const subscriptionUow = new KyselyUnitOfWork<SubscriptionTransaction>(db, (trx) => ({
    subscriptions: new PostgresSubscriptionRepository(trx),
    payments: new PostgresPaymentRepository(trx),
  }));

  const ai =
    overrides.ai ??
    new MockOpenAiChatClient({
      minLatencyMs: config.mockAi.minLatencyMs,
      maxLatencyMs: config.mockAi.maxLatencyMs,
      failureRate: config.mockAi.failureRate,
    });
  const payments =
    overrides.payments ??
    new SimulatedPaymentGateway({ failureRate: config.billing.paymentFailureRate });

  const chatMessages = new PostgresChatMessageRepository(db);
  const quota = new PostgresQuotaRepository(db);
  const subscriptions = new PostgresSubscriptionRepository(db);

  const billing = new RunBillingCycleUseCase({
    uow: subscriptionUow,
    payments,
    clock,
    ids,
    maxPerRun: BILLING_BATCH_LIMIT,
  });

  const rateLimitStore =
    overrides.rateLimitStore ??
    (config.rateLimit.store === 'postgres'
      ? new PostgresRateLimitStore(db)
      : new MemoryRateLimitStore());

  const auth: AuthenticateDependencies = {
    tokens: new OidcAccessTokenVerifier({
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      jwksUri: config.oidc.jwksUri,
      algorithms: config.oidc.algorithms,
      rolesClaim: config.oidc.rolesClaim,
      clockToleranceSec: config.oidc.clockToleranceSec,
      maxTokenLifetimeSec: config.oidc.maxTokenLifetimeSec,
    }),
    dpop: new DpopProofVerifier({
      algorithms: config.dpop.algorithms,
      maxAgeSec: config.dpop.proofMaxAgeSec,
      clockSkewSec: config.oidc.clockToleranceSec,
      replayCache: new PostgresReplayCache(db),
    }),
    users: new PostgresUserRepository(db),
    sessions: new PostgresAuthSessionRepository(db),
    // Token and proof freshness is always judged against real time.
    clock: systemClock,
    publicBaseUrl: config.server.publicBaseUrl,
    requireBoundTokens: config.dpop.requireBoundTokens,
  };

  const reaper = new ReapAbandonedReservationsUseCase({ quota, clock });

  const jobs = new BackgroundJobs({
    intervalMs: config.billing.intervalMs,
    logger,
    billing,
    reaper,
    db,
    now: () => clock.now(),
  });

  return {
    config,
    logger,
    db,
    clock,
    startedAt: new Date(),
    rateLimitStore,
    rateLimitClock: overrides.rateLimitClock ?? Date.now,
    auth,
    chat: {
      ask: new AskQuestionUseCase({
        uow: chatUow,
        messages: chatMessages,
        ai,
        clock,
        ids,
        freeMessagesPerMonth: config.quota.freeMessagesPerMonth,
      }),
      queries: new ChatQueries({
        messages: chatMessages,
        quota,
        clock,
        freeMessagesPerMonth: config.quota.freeMessagesPerMonth,
      }),
      reaper,
    },
    subscriptions: {
      commands: new SubscriptionCommands({
        uow: subscriptionUow,
        subscriptions,
        payments,
        clock,
        ids,
      }),
      queries: new SubscriptionQueries({ subscriptions }),
      billing,
    },
    analytics: {
      metrics: new GetSystemMetricsUseCase({ metrics: new PostgresMetricsRepository(db), clock }),
    },
    jobs,
    async close() {
      await jobs.stop();
      await db.destroy();
    },
  };
}
