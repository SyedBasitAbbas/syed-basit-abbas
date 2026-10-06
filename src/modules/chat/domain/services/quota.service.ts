import { monthLabel } from '../../../../shared/domain/calendar.js';
import { QuotaExceededError, type QuotaExceededDetails } from '../../../../shared/domain/errors.js';
import type { BundleAllowance } from '../entities/bundle-allowance.js';
import type { FreeMonthlyUsage } from '../entities/free-monthly-usage.js';

export type QuotaDecision =
  | { source: 'free'; usage: FreeMonthlyUsage }
  | { source: 'subscription'; allowance: BundleAllowance };

/**
 * Bundle selection rule: deduct from the most recently purchased active bundle
 * that still has messages left in its current cycle ("latest remaining quota").
 * Ties are broken by id so the choice is deterministic.
 */
export function selectBundleForDeduction(
  bundles: readonly BundleAllowance[],
  now: Date,
): BundleAllowance | null {
  const candidates = bundles.filter((bundle) => bundle.coversInstant(now) && bundle.hasRemaining());
  candidates.sort(
    (a, b) =>
      b.purchasedAt.getTime() - a.purchasedAt.getTime() ||
      (a.subscriptionId < b.subscriptionId ? 1 : -1),
  );
  return candidates[0] ?? null;
}

/**
 * Decides where the next message is charged: the free monthly quota first,
 * then the latest bundle with remaining quota. Throws a typed
 * `QuotaExceededError` when nothing is left.
 */
export function decideQuotaSource(
  free: FreeMonthlyUsage,
  bundles: readonly BundleAllowance[],
  now: Date,
): QuotaDecision {
  if (free.hasRemaining()) {
    return { source: 'free', usage: free };
  }
  const bundle = selectBundleForDeduction(bundles, now);
  if (bundle) {
    return { source: 'subscription', allowance: bundle };
  }
  throw new QuotaExceededError(describeExhaustedQuota(free, bundles, now));
}

export function describeExhaustedQuota(
  free: FreeMonthlyUsage,
  bundles: readonly BundleAllowance[],
  now: Date,
): QuotaExceededDetails {
  const active = bundles.filter((bundle) => bundle.coversInstant(now));
  return {
    period: monthLabel(free.periodStart),
    free: {
      limit: free.limit,
      used: free.used,
      remaining: free.remaining,
      resetsAt: free.resetsAt.toISOString(),
    },
    bundles: {
      active: active.length,
      withRemainingQuota: active.filter((bundle) => bundle.hasRemaining()).length,
    },
  };
}

export interface QuotaSnapshot {
  period: string;
  free: { limit: number; used: number; remaining: number; resetsAt: Date };
  bundles: {
    subscriptionId: string;
    tier: string;
    maxMessages: number | null;
    used: number;
    remaining: number | null;
    periodEnd: Date;
  }[];
  /** Total messages the user can still send; `null` = unlimited. */
  totalRemaining: number | null;
  /** Where the next message would be charged, if anywhere. */
  nextCharge: { source: 'free' } | { source: 'subscription'; subscriptionId: string } | null;
}

export function buildQuotaSnapshot(
  free: FreeMonthlyUsage,
  bundles: readonly BundleAllowance[],
  now: Date,
): QuotaSnapshot {
  const active = bundles.filter((bundle) => bundle.coversInstant(now));
  const unlimited = active.some((bundle) => bundle.isUnlimited);
  const totalRemaining = unlimited
    ? null
    : free.remaining + active.reduce((sum, bundle) => sum + (bundle.remaining ?? 0), 0);

  let nextCharge: QuotaSnapshot['nextCharge'] = null;
  if (free.hasRemaining()) {
    nextCharge = { source: 'free' };
  } else {
    const bundle = selectBundleForDeduction(active, now);
    if (bundle) nextCharge = { source: 'subscription', subscriptionId: bundle.subscriptionId };
  }

  return {
    period: monthLabel(free.periodStart),
    free: {
      limit: free.limit,
      used: free.used,
      remaining: free.remaining,
      resetsAt: free.resetsAt,
    },
    bundles: active.map((bundle) => ({
      subscriptionId: bundle.subscriptionId,
      tier: bundle.tier,
      maxMessages: bundle.maxMessages,
      used: bundle.used,
      remaining: bundle.remaining,
      periodEnd: bundle.periodEnd,
    })),
    totalRemaining,
    nextCharge,
  };
}
