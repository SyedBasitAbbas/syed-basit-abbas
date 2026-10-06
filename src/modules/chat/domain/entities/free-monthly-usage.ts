import { startOfNextUtcMonth, startOfUtcMonth } from '../../../../shared/domain/calendar.js';

/**
 * Free messages a user consumed in one calendar month (UTC).
 * Usage is keyed by month, so the quota resets automatically on the 1st:
 * a new month simply starts from a new, empty counter.
 */
export class FreeMonthlyUsage {
  private constructor(
    readonly userId: string,
    readonly periodStart: Date,
    private usedCount: number,
    readonly limit: number,
  ) {}

  static of(input: {
    userId: string;
    periodStart: Date;
    used: number;
    limit: number;
  }): FreeMonthlyUsage {
    if (input.used < 0 || input.limit < 0) {
      throw new Error('Invariant violated: usage counters cannot be negative');
    }
    return new FreeMonthlyUsage(
      input.userId,
      startOfUtcMonth(input.periodStart),
      input.used,
      input.limit,
    );
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  get resetsAt(): Date {
    return startOfNextUtcMonth(this.periodStart);
  }

  hasRemaining(): boolean {
    return this.remaining > 0;
  }

  consume(): void {
    if (!this.hasRemaining()) {
      throw new Error('Invariant violated: free quota already exhausted');
    }
    this.usedCount += 1;
  }
}
