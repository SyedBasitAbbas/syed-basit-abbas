import { describe, expect, it } from 'vitest';
import { Subscription } from '../../../src/modules/subscriptions/domain/entities/subscription.js';
import {
  addBillingCycle,
  PLAN_CATALOG,
} from '../../../src/modules/subscriptions/domain/services/plan-catalog.js';
import { SubscriptionNotActiveError } from '../../../src/shared/domain/errors.js';

const T0 = new Date('2026-01-31T12:00:00Z');

function create(overrides: Partial<Parameters<typeof Subscription.create>[0]> = {}) {
  return Subscription.create({
    id: 's1',
    userId: 'u1',
    tier: 'basic',
    billingCycle: 'monthly',
    autoRenew: true,
    now: T0,
    ...overrides,
  });
}

describe('Subscription lifecycle', () => {
  it('is created active with catalog allowance and price', () => {
    const s = create({ tier: 'pro', billingCycle: 'yearly' }).toSnapshot();
    expect(s).toMatchObject({
      status: 'active',
      inactiveReason: null,
      maxMessages: 1_200,
      priceCents: PLAN_CATALOG.pro.priceCents.yearly,
      startDate: T0,
      endDate: new Date('2027-01-31T12:00:00Z'),
      renewalDate: new Date('2027-01-31T12:00:00Z'),
    });
    expect(create({ tier: 'enterprise' }).toSnapshot().maxMessages).toBeNull();
  });

  it('has no renewal date when auto-renew is off', () => {
    expect(create({ autoRenew: false }).toSnapshot().renewalDate).toBeNull();
  });

  it('is usable only inside its billing cycle', () => {
    const s = create();
    expect(s.isActiveAt(T0)).toBe(true);
    expect(s.isActiveAt(new Date('2026-02-28T11:59:59Z'))).toBe(true);
    expect(s.isActiveAt(new Date('2026-02-28T12:00:00Z'))).toBe(false);
  });

  it('toggles auto-renew and keeps renewalDate consistent', () => {
    const s = create();
    s.setAutoRenew(false, T0);
    expect(s.toSnapshot()).toMatchObject({ autoRenew: false, renewalDate: null });
    s.setAutoRenew(true, T0);
    expect(s.toSnapshot().renewalDate).toEqual(s.endDate);
  });

  it('cancellation ends the cycle now and stops renewals', () => {
    const s = create();
    const at = new Date('2026-02-10T08:00:00Z');
    s.cancel(at);
    expect(s.toSnapshot()).toMatchObject({
      status: 'inactive',
      inactiveReason: 'cancelled',
      autoRenew: false,
      renewalDate: null,
      cancelledAt: at,
      endDate: at,
    });
    expect(s.isActiveAt(at)).toBe(false);
    expect(s.billingActionAt(new Date('2026-03-01T00:00:00Z'))).toBe('none');
    expect(() => s.cancel(at)).toThrow(SubscriptionNotActiveError);
    expect(() => s.setAutoRenew(true, at)).toThrow(SubscriptionNotActiveError);
  });

  it('asks for renewal at the end of the cycle when auto-renew is on', () => {
    const s = create();
    expect(s.billingActionAt(new Date('2026-02-28T11:59:59Z'))).toBe('none');
    expect(s.billingActionAt(new Date('2026-02-28T12:00:00Z'))).toBe('renew');
  });

  it('renews into a contiguous next cycle', () => {
    const s = create();
    const at = new Date('2026-02-28T12:00:05Z');
    s.renew(at);
    expect(s.toSnapshot()).toMatchObject({
      status: 'active',
      startDate: new Date('2026-02-28T12:00:00Z'),
      endDate: new Date('2026-03-28T12:00:00Z'),
      renewalDate: new Date('2026-03-28T12:00:00Z'),
    });
  });

  it('starts a fresh cycle when renewal is more than a cycle late', () => {
    const s = create();
    const late = new Date('2026-06-01T00:00:00Z');
    s.renew(late);
    expect(s.toSnapshot().startDate).toEqual(late);
    expect(s.toSnapshot().endDate).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  it('becomes inactive when a payment fails', () => {
    const s = create();
    s.markPaymentFailed(new Date('2026-02-28T12:00:00Z'));
    expect(s.toSnapshot()).toMatchObject({
      status: 'inactive',
      inactiveReason: 'payment_failed',
      autoRenew: false,
      renewalDate: null,
    });
  });

  it('expires at the end of the cycle when auto-renew is off', () => {
    const s = create({ autoRenew: false });
    const end = new Date('2026-02-28T12:00:00Z');
    expect(s.billingActionAt(end)).toBe('expire');
    s.expire(end);
    expect(s.toSnapshot()).toMatchObject({ status: 'inactive', inactiveReason: 'expired' });
  });

  it('refuses lifecycle transitions that do not apply', () => {
    const s = create();
    expect(() => s.renew(T0)).toThrow(/Invariant/);
    expect(() => s.expire(T0)).toThrow(/Invariant/);
  });
});

describe('billing periods', () => {
  it.each([
    ['2026-01-31T00:00:00Z', 'monthly', '2026-02-28T00:00:00.000Z'],
    ['2028-01-31T00:00:00Z', 'monthly', '2028-02-29T00:00:00.000Z'],
    ['2026-03-15T09:30:00Z', 'monthly', '2026-04-15T09:30:00.000Z'],
    ['2026-12-31T23:00:00Z', 'monthly', '2027-01-31T23:00:00.000Z'],
    ['2028-02-29T00:00:00Z', 'yearly', '2029-02-28T00:00:00.000Z'],
  ] as const)('%s + 1 %s cycle = %s', (from, cycle, expected) => {
    expect(addBillingCycle(new Date(from), cycle).toISOString()).toBe(expected);
  });
});
