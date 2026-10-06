import { describe, expect, it } from 'vitest';
import { BundleAllowance } from '../../../src/modules/chat/domain/entities/bundle-allowance.js';
import { FreeMonthlyUsage } from '../../../src/modules/chat/domain/entities/free-monthly-usage.js';
import {
  buildQuotaSnapshot,
  decideQuotaSource,
  selectBundleForDeduction,
} from '../../../src/modules/chat/domain/services/quota.service.js';
import { QuotaExceededError } from '../../../src/shared/domain/errors.js';

const NOW = new Date('2026-05-20T10:00:00Z');

function free(used: number, limit = 3) {
  return FreeMonthlyUsage.of({ userId: 'u1', periodStart: NOW, used, limit });
}

function bundle(
  id: string,
  overrides: Partial<{
    maxMessages: number | null;
    used: number;
    purchasedAt: string;
    periodStart: string;
    periodEnd: string;
  }> = {},
) {
  return BundleAllowance.of({
    subscriptionId: id,
    tier: overrides.maxMessages === null ? 'enterprise' : 'basic',
    maxMessages: overrides.maxMessages === undefined ? 10 : overrides.maxMessages,
    used: overrides.used ?? 0,
    periodStart: new Date(overrides.periodStart ?? '2026-05-01T00:00:00Z'),
    periodEnd: new Date(overrides.periodEnd ?? '2026-06-01T00:00:00Z'),
    purchasedAt: new Date(overrides.purchasedAt ?? '2026-05-01T00:00:00Z'),
  });
}

describe('quota calculation', () => {
  it('charges the free monthly quota first', () => {
    const decision = decideQuotaSource(free(2), [bundle('b1')], NOW);
    expect(decision.source).toBe('free');
  });

  it('moves to a bundle once the 3 free messages are used', () => {
    const decision = decideQuotaSource(free(3), [bundle('b1')], NOW);
    expect(decision).toMatchObject({ source: 'subscription' });
    expect(decision.source === 'subscription' && decision.allowance.subscriptionId).toBe('b1');
  });

  it('deducts from the latest purchased bundle that still has quota', () => {
    const older = bundle('older', { purchasedAt: '2026-05-01T00:00:00Z' });
    const latest = bundle('latest', { purchasedAt: '2026-05-10T00:00:00Z' });
    const latestButEmpty = bundle('empty', { purchasedAt: '2026-05-15T00:00:00Z', used: 10 });
    expect(selectBundleForDeduction([older, latestButEmpty, latest], NOW)?.subscriptionId).toBe(
      'latest',
    );
  });

  it('breaks purchase-time ties deterministically', () => {
    const a = bundle('aaaa');
    const b = bundle('bbbb');
    expect(selectBundleForDeduction([a, b], NOW)?.subscriptionId).toBe('bbbb');
    expect(selectBundleForDeduction([b, a], NOW)?.subscriptionId).toBe('bbbb');
  });

  it('ignores bundles outside their billing cycle', () => {
    const expired = bundle('expired', { periodEnd: '2026-05-20T10:00:00Z' });
    const future = bundle('future', { periodStart: '2026-05-21T00:00:00Z' });
    expect(selectBundleForDeduction([expired, future], NOW)).toBeNull();
  });

  it('treats unlimited (Enterprise) bundles as always having quota', () => {
    const enterprise = bundle('ent', { maxMessages: null, used: 1_000_000 });
    expect(enterprise.remaining).toBeNull();
    expect(selectBundleForDeduction([enterprise], NOW)?.subscriptionId).toBe('ent');
  });

  it('throws a typed QuotaExceededError with details when nothing is left', () => {
    const exhausted = bundle('b1', { used: 10 });
    try {
      decideQuotaSource(free(3), [exhausted], NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect((error as QuotaExceededError).details).toEqual({
        period: '2026-05',
        free: { limit: 3, used: 3, remaining: 0, resetsAt: '2026-06-01T00:00:00.000Z' },
        bundles: { active: 1, withRemainingQuota: 0 },
      });
    }
  });

  it('reports the total remaining quota and the next charge', () => {
    const snapshot = buildQuotaSnapshot(
      free(1),
      [bundle('b1', { used: 4 }), bundle('b2', { used: 9, purchasedAt: '2026-05-02T00:00:00Z' })],
      NOW,
    );
    expect(snapshot.totalRemaining).toBe(2 + 6 + 1);
    expect(snapshot.nextCharge).toEqual({ source: 'free' });

    const unlimited = buildQuotaSnapshot(free(3), [bundle('ent', { maxMessages: null })], NOW);
    expect(unlimited.totalRemaining).toBeNull();
    expect(unlimited.nextCharge).toEqual({ source: 'subscription', subscriptionId: 'ent' });
  });
});

describe('FreeMonthlyUsage', () => {
  it('is keyed by calendar month and resets on the 1st (UTC)', () => {
    const usage = FreeMonthlyUsage.of({
      userId: 'u1',
      periodStart: new Date('2026-12-31T23:59:59Z'),
      used: 0,
      limit: 3,
    });
    expect(usage.periodStart.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(usage.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('never consumes beyond its limit', () => {
    const usage = free(2);
    usage.consume();
    expect(usage.remaining).toBe(0);
    expect(() => usage.consume()).toThrow(/exhausted/);
  });
});

describe('BundleAllowance', () => {
  it('never consumes beyond its allowance', () => {
    const allowance = bundle('b1', { used: 9 });
    allowance.consume();
    expect(allowance.remaining).toBe(0);
    expect(() => allowance.consume()).toThrow(/exhausted/);
  });
});
