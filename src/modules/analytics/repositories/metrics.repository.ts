export interface SystemMetrics {
  users: { total: number; activeThisMonth: number };
  usage: {
    period: string;
    messagesThisMonth: number;
    byStatus: Record<'pending' | 'completed' | 'failed', number>;
    bySource: Record<'free' | 'subscription', number>;
    tokensThisMonth: { prompt: number; completion: number; total: number };
    messagesAllTime: number;
  };
  subscriptions: {
    active: number;
    inactive: number;
    autoRenewEnabled: number;
    byTier: Record<'basic' | 'pro' | 'enterprise', { active: number; total: number }>;
    inactiveByReason: Record<'cancelled' | 'payment_failed' | 'expired', number>;
  };
  billing: { paymentsSucceeded: number; paymentsFailed: number; revenueCents: number };
}

export interface MetricsRepository {
  collect(now: Date): Promise<SystemMetrics>;
}
