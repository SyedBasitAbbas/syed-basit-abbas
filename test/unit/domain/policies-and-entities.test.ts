import { describe, expect, it } from 'vitest';
import { AnalyticsPolicy } from '../../../src/modules/analytics/domain/policies/analytics.policy.js';
import { ChatMessage } from '../../../src/modules/chat/domain/entities/chat-message.js';
import {
  Question,
  QUESTION_MAX_LENGTH,
} from '../../../src/modules/chat/domain/entities/question.js';
import { ChatPolicy } from '../../../src/modules/chat/domain/policies/chat.policy.js';
import { SubscriptionPolicy } from '../../../src/modules/subscriptions/domain/policies/subscription.policy.js';
import { Actor } from '../../../src/shared/domain/actor.js';
import { DomainValidationError } from '../../../src/shared/domain/errors.js';

const alice = Actor.of('alice', ['user']);
const bob = Actor.of('bob', ['user']);
const admin = Actor.of('root', ['admin']);
const roleless = Actor.of('ghost', []);

describe('domain policies', () => {
  it('chat: users read only their own messages, admins read everything', () => {
    const message = { userId: 'alice' };
    expect(ChatPolicy.canRead(alice, message)).toBe(true);
    expect(ChatPolicy.canRead(bob, message)).toBe(false);
    expect(ChatPolicy.canRead(admin, message)).toBe(true);
    expect(ChatPolicy.canListAll(alice)).toBe(false);
    expect(ChatPolicy.canListAll(admin)).toBe(true);
    expect(ChatPolicy.canReadUsageOf(alice, 'bob')).toBe(false);
    expect(ChatPolicy.canAsk(roleless)).toBe(false);
  });

  it('subscriptions: ownership or admin', () => {
    const subscription = { userId: 'alice' };
    expect(SubscriptionPolicy.canManage(alice, subscription)).toBe(true);
    expect(SubscriptionPolicy.canManage(bob, subscription)).toBe(false);
    expect(SubscriptionPolicy.canView(admin, subscription)).toBe(true);
    expect(SubscriptionPolicy.canRunBilling(alice)).toBe(false);
    expect(SubscriptionPolicy.canRunBilling(admin)).toBe(true);
    expect(SubscriptionPolicy.canPurchase(roleless)).toBe(false);
  });

  it('analytics: admins only', () => {
    expect(AnalyticsPolicy.canViewSystemMetrics(alice)).toBe(false);
    expect(AnalyticsPolicy.canViewSystemMetrics(admin)).toBe(true);
  });
});

describe('Question', () => {
  it('normalizes and trims', () => {
    // "e" + combining acute accent becomes the single precomposed character.
    expect(Question.create('  cafe\u0301  ').value).toBe('caf\u00e9');
  });

  it.each([
    ['empty', '   '],
    ['too long', 'x'.repeat(QUESTION_MAX_LENGTH + 1)],
    ['control characters', 'hello\u0000world'],
  ])('rejects %s input', (_label, input) => {
    expect(() => Question.create(input)).toThrow(DomainValidationError);
  });
});

describe('ChatMessage', () => {
  const reserve = () =>
    ChatMessage.reserve({
      id: 'm1',
      userId: 'alice',
      question: Question.create('hi'),
      charge: {
        source: 'free',
        subscriptionId: null,
        periodStart: new Date('2026-05-01T00:00:00Z'),
      },
      requestId: 'req-1',
      now: new Date('2026-05-02T00:00:00Z'),
    });

  it('moves from pending to completed with consistent token usage', () => {
    const message = reserve();
    expect(message.status).toBe('pending');
    message.complete(
      {
        answer: 'hello',
        tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        model: 'm',
        providerResponseId: 'r',
        latencyMs: 10,
      },
      new Date(),
    );
    expect(message.toSnapshot()).toMatchObject({ status: 'completed', answer: 'hello' });
  });

  it('rejects inconsistent token usage and double settlement', () => {
    const message = reserve();
    expect(() =>
      message.complete(
        {
          answer: 'x',
          tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 6 },
          model: 'm',
          providerResponseId: 'r',
          latencyMs: 1,
        },
        new Date(),
      ),
    ).toThrow(/token usage/);
    message.fail('AI_PROVIDER_UNAVAILABLE', new Date());
    expect(() => message.fail('AGAIN', new Date())).toThrow(/already failed/);
  });

  it('requires a subscription id exactly when charged to a subscription', () => {
    expect(() =>
      ChatMessage.reserve({
        id: 'm2',
        userId: 'alice',
        question: Question.create('hi'),
        charge: { source: 'subscription', subscriptionId: null, periodStart: new Date() },
        requestId: 'r',
        now: new Date(),
      }),
    ).toThrow(/subscription id/);
  });
});
