export interface BundleAllowanceProps {
  subscriptionId: string;
  tier: string;
  /** `null` = unlimited. */
  maxMessages: number | null;
  /** Messages consumed in the current billing cycle. */
  used: number;
  periodStart: Date;
  periodEnd: Date;
  /** When the bundle was purchased; drives the "latest bundle first" rule. */
  purchasedAt: Date;
}

/**
 * The chat module's view of a subscription bundle: how many messages it can
 * still provide in its current billing cycle. Lifecycle rules stay in the
 * subscriptions module; this value object only answers quota questions.
 */
export class BundleAllowance {
  private constructor(private props: BundleAllowanceProps) {}

  static of(props: BundleAllowanceProps): BundleAllowance {
    if (props.used < 0) {
      throw new Error('Invariant violated: usage counters cannot be negative');
    }
    return new BundleAllowance({ ...props });
  }

  get subscriptionId(): string {
    return this.props.subscriptionId;
  }

  get tier(): string {
    return this.props.tier;
  }

  get maxMessages(): number | null {
    return this.props.maxMessages;
  }

  get used(): number {
    return this.props.used;
  }

  get periodStart(): Date {
    return this.props.periodStart;
  }

  get periodEnd(): Date {
    return this.props.periodEnd;
  }

  get purchasedAt(): Date {
    return this.props.purchasedAt;
  }

  get isUnlimited(): boolean {
    return this.props.maxMessages === null;
  }

  /** Messages left in the current cycle; `null` = unlimited. */
  get remaining(): number | null {
    return this.props.maxMessages === null
      ? null
      : Math.max(0, this.props.maxMessages - this.props.used);
  }

  hasRemaining(): boolean {
    const remaining = this.remaining;
    return remaining === null || remaining > 0;
  }

  coversInstant(now: Date): boolean {
    return (
      this.props.periodStart.getTime() <= now.getTime() &&
      now.getTime() < this.props.periodEnd.getTime()
    );
  }

  consume(): void {
    if (!this.hasRemaining()) {
      throw new Error('Invariant violated: bundle allowance already exhausted');
    }
    this.props.used += 1;
  }
}
