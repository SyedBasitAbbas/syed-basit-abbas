import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date, Date>;
type DefaultTimestamp = ColumnType<Date, Date | undefined, Date>;

export interface UsersTable {
  id: Generated<string>;
  idp_issuer: string;
  idp_subject: string;
  email: string | null;
  created_at: DefaultTimestamp;
}

export interface AuthSessionsTable {
  session_key: string;
  user_id: string;
  jkt: string;
  binding_source: 'cnf' | 'first_use';
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export interface DpopProofReplaysTable {
  proof_key: string;
  expires_at: Timestamp;
}

export interface SubscriptionsTable {
  id: string;
  user_id: string;
  tier: 'basic' | 'pro' | 'enterprise';
  billing_cycle: 'monthly' | 'yearly';
  max_messages: number | null;
  price_cents: number;
  currency: string;
  auto_renew: boolean;
  status: 'active' | 'inactive';
  inactive_reason: 'cancelled' | 'payment_failed' | 'expired' | null;
  start_date: Timestamp;
  end_date: Timestamp;
  renewal_date: Timestamp | null;
  cancelled_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SubscriptionUsageTable {
  subscription_id: string;
  period_start: Timestamp;
  used: number;
  max_messages: number | null;
  updated_at: DefaultTimestamp;
}

export interface FreeUsageMonthlyTable {
  user_id: string;
  /** `YYYY-MM-01` (DATE kept as a string, see database.ts). */
  period_month: string;
  used: number;
  free_limit: number;
  updated_at: DefaultTimestamp;
}

export interface ChatMessagesTable {
  id: string;
  user_id: string;
  question: string;
  answer: string | null;
  status: 'pending' | 'completed' | 'failed';
  quota_source: 'free' | 'subscription';
  subscription_id: string | null;
  quota_period_start: Timestamp;
  model: string | null;
  provider_response_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  failure_code: string | null;
  request_id: string;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface PaymentsTable {
  id: string;
  subscription_id: string;
  user_id: string;
  kind: 'initial' | 'renewal';
  amount_cents: number;
  currency: string;
  status: 'succeeded' | 'failed';
  failure_reason: string | null;
  provider_reference: string | null;
  period_start: Timestamp;
  period_end: Timestamp;
  created_at: Timestamp;
}

export interface RateLimitBucketsTable {
  bucket_key: string;
  window_start: Timestamp;
  hits: number;
  expires_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  auth_sessions: AuthSessionsTable;
  dpop_proof_replays: DpopProofReplaysTable;
  subscriptions: SubscriptionsTable;
  subscription_usage: SubscriptionUsageTable;
  free_usage_monthly: FreeUsageMonthlyTable;
  chat_messages: ChatMessagesTable;
  payments: PaymentsTable;
  rate_limit_buckets: RateLimitBucketsTable;
}
