/**
 * Error model shared by every layer.
 *
 * Pure TypeScript: the domain raises business failures with a stable `code`,
 * and only the HTTP layer decides which status code a code maps to.
 * `ErrorDetailsByCode` makes the error payloads typed end to end.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'BODY_NOT_ALLOWED',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHENTICATED',
  'INVALID_TOKEN',
  'INVALID_DPOP_PROOF',
  'DPOP_PROOF_REPLAYED',
  'TOKEN_BINDING_MISMATCH',
  'SESSION_REVOKED',
  'FORBIDDEN',
  'CORS_ORIGIN_DENIED',
  'NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'SUBSCRIPTION_NOT_ACTIVE',
  'QUOTA_EXCEEDED',
  'PAYMENT_FAILED',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'AI_PROVIDER_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ValidationIssue {
  location: 'body' | 'query' | 'params' | 'headers' | 'domain';
  path: string;
  message: string;
  code: string;
}

export interface QuotaExceededDetails {
  /** Calendar month (UTC) the free quota belongs to, `YYYY-MM`. */
  period: string;
  free: { limit: number; used: number; remaining: number; resetsAt: string };
  bundles: { active: number; withRemainingQuota: number };
}

export interface ErrorDetailsByCode {
  VALIDATION_FAILED: { issues: ValidationIssue[] };
  QUOTA_EXCEEDED: QuotaExceededDetails;
  PAYMENT_FAILED: { subscriptionId: string; paymentId: string; reason: string };
  SUBSCRIPTION_NOT_ACTIVE: { subscriptionId: string; status: string };
  RATE_LIMITED: {
    policy: string;
    scope: 'ip' | 'user';
    limit: number;
    windowSeconds: number;
    retryAfterSeconds: number;
  };
  PAYLOAD_TOO_LARGE: { limitBytes: number };
  REQUEST_TIMEOUT: { timeoutMs: number };
}

export type ErrorDetails<C extends ErrorCode> = C extends keyof ErrorDetailsByCode
  ? ErrorDetailsByCode[C]
  : Record<string, unknown>;

export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: ErrorDetails<C> | undefined;

  constructor(code: C, message: string, details?: ErrorDetails<C>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export class NotFoundError extends AppError<'NOT_FOUND'> {
  constructor(resource: string) {
    super('NOT_FOUND', `${resource} not found`);
  }
}

export class ForbiddenError extends AppError<'FORBIDDEN'> {
  constructor(message = 'You are not allowed to perform this action') {
    super('FORBIDDEN', message);
  }
}

export class DomainValidationError extends AppError<'VALIDATION_FAILED'> {
  constructor(path: string, message: string) {
    super('VALIDATION_FAILED', message, {
      issues: [{ location: 'domain', path, message, code: 'domain_rule' }],
    });
  }
}

export class QuotaExceededError extends AppError<'QUOTA_EXCEEDED'> {
  constructor(details: QuotaExceededDetails) {
    super(
      'QUOTA_EXCEEDED',
      'Monthly free quota is used up and no active subscription bundle has messages left.',
      details,
    );
  }
}

export class PaymentFailedError extends AppError<'PAYMENT_FAILED'> {
  constructor(details: ErrorDetailsByCode['PAYMENT_FAILED']) {
    super('PAYMENT_FAILED', 'Payment was declined; the subscription is inactive.', details);
  }
}

export class SubscriptionNotActiveError extends AppError<'SUBSCRIPTION_NOT_ACTIVE'> {
  constructor(subscriptionId: string, status: string) {
    super('SUBSCRIPTION_NOT_ACTIVE', 'This operation requires an active subscription.', {
      subscriptionId,
      status,
    });
  }
}
