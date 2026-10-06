import type { BundleAllowance } from '../domain/entities/bundle-allowance.js';
import type { QuotaCharge } from '../domain/entities/chat-message.js';
import type { FreeMonthlyUsage } from '../domain/entities/free-monthly-usage.js';

/**
 * Persistence port for quota accounting. `lockQuota` must serialize every quota
 * decision of one user until the transaction ends, and the `consume*` methods
 * must re-check the limit atomically in the database.
 */
export interface QuotaRepository {
  /** Takes the user's quota lock and returns this month's free usage (created if needed). */
  lockQuota(userId: string, periodStart: Date, limit: number): Promise<FreeMonthlyUsage>;
  /** Reads this month's free usage without locking (used by read endpoints). */
  readFreeUsage(userId: string, periodStart: Date, limit: number): Promise<FreeMonthlyUsage>;
  /** Bundles active at `now` with their usage in the current billing cycle. */
  findActiveBundles(
    userId: string,
    now: Date,
    options: { lock: boolean },
  ): Promise<BundleAllowance[]>;
  consumeFree(userId: string, periodStart: Date): Promise<void>;
  consumeBundle(
    subscriptionId: string,
    periodStart: Date,
    maxMessages: number | null,
  ): Promise<void>;
  /** Gives back one unit to the period it was charged to. */
  refund(userId: string, charge: QuotaCharge): Promise<void>;
  /**
   * Fails messages still `pending` since before `olderThan` (the process died
   * between reserving and settling) and refunds their units. Returns how many.
   */
  reapAbandonedReservations(olderThan: Date): Promise<number>;
}
