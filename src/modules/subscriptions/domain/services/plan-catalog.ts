import { addUtcMonths } from '../../../../shared/domain/calendar.js';

export const SUBSCRIPTION_TIERS = ['basic', 'pro', 'enterprise'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const BILLING_CYCLES = ['monthly', 'yearly'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export interface Plan {
  tier: SubscriptionTier;
  /** Messages per month; `null` means unlimited. */
  monthlyMessages: number | null;
  /** Prices in minor units (cents), per billing cycle. */
  priceCents: Readonly<Record<BillingCycle, number>>;
  currency: 'USD';
}

/**
 * Server-side catalog. Clients only choose a tier and a cycle; message allowance
 * and price always come from here, so they cannot be tampered with (mass assignment).
 * Yearly is priced as 10 months (2 months free).
 */
export const PLAN_CATALOG: Readonly<Record<SubscriptionTier, Plan>> = {
  basic: {
    tier: 'basic',
    monthlyMessages: 10,
    priceCents: { monthly: 999, yearly: 9_990 },
    currency: 'USD',
  },
  pro: {
    tier: 'pro',
    monthlyMessages: 100,
    priceCents: { monthly: 2_999, yearly: 29_990 },
    currency: 'USD',
  },
  enterprise: {
    tier: 'enterprise',
    monthlyMessages: null,
    priceCents: { monthly: 19_999, yearly: 199_990 },
    currency: 'USD',
  },
};

/** Messages a bundle grants per billing cycle: a yearly cycle carries 12 months of allowance. */
export function messageAllowance(plan: Plan, cycle: BillingCycle): number | null {
  if (plan.monthlyMessages === null) return null;
  return cycle === 'yearly' ? plan.monthlyMessages * 12 : plan.monthlyMessages;
}

export function addBillingCycle(date: Date, cycle: BillingCycle): Date {
  switch (cycle) {
    case 'monthly':
      return addUtcMonths(date, 1);
    case 'yearly':
      return addUtcMonths(date, 12);
  }
}
