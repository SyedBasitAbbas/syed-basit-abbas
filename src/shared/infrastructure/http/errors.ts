import type { ErrorRequestHandler, Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError, isAppError, type ErrorCode, type ErrorDetails } from '../../domain/errors.js';

/** The request id assigned by the logging middleware. */
export function requestIdOf(req: Request): string {
  return typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : 'unknown';
}

/** Single source of truth for code -> HTTP status. Exhaustive by type. */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  MALFORMED_JSON: 400,
  BODY_NOT_ALLOWED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  INVALID_DPOP_PROOF: 401,
  DPOP_PROOF_REPLAYED: 401,
  TOKEN_BINDING_MISMATCH: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  CORS_ORIGIN_DENIED: 403,
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  SUBSCRIPTION_NOT_ACTIVE: 409,
  QUOTA_EXCEEDED: 402,
  PAYMENT_FAILED: 402,
  RATE_LIMITED: 429,
  REQUEST_TIMEOUT: 503,
  AI_PROVIDER_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Wire format of every error response. */
export interface ApiErrorBody<C extends ErrorCode = ErrorCode> {
  error: {
    code: C;
    message: string;
    details?: ErrorDetails<C>;
    requestId: string;
  };
}

export const DPOP_ALGS_CHALLENGE = 'ES256 EdDSA RS256 PS256';

/** Keeps header values to printable ASCII without quotes, so they can never break the header. */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7E]|["\\]/g, ' ').slice(0, 200);
}

function wwwAuthenticate(error: AppError): string {
  const challenge = `DPoP algs="${DPOP_ALGS_CHALLENGE}"`;
  if (error.code === 'UNAUTHENTICATED') return challenge;
  const oauthError =
    error.code === 'INVALID_DPOP_PROOF' || error.code === 'DPOP_PROOF_REPLAYED'
      ? 'invalid_dpop_proof'
      : 'invalid_token';
  return `${challenge}, error="${oauthError}", error_description="${headerSafe(error.message)}"`;
}

interface BodyParserError {
  type: string;
  status?: number;
}

function isBodyParserError(error: unknown): error is BodyParserError {
  return (
    typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
  );
}

export function toAppError(error: unknown, bodyLimitBytes: number): AppError {
  if (isAppError(error)) return error;
  if (isBodyParserError(error)) {
    switch (error.type) {
      case 'entity.too.large':
        return new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${bodyLimitBytes} bytes.`, {
          limitBytes: bodyLimitBytes,
        });
      case 'entity.parse.failed':
        return new AppError('MALFORMED_JSON', 'Request body is not valid JSON.');
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return new AppError(
          'UNSUPPORTED_MEDIA_TYPE',
          'Only uncompressed UTF-8 JSON bodies are accepted.',
        );
      case 'request.aborted':
      case 'request.size.invalid':
        return new AppError('VALIDATION_FAILED', 'Request body was incomplete.', { issues: [] });
      default:
        break;
    }
  }
  return new AppError('INTERNAL_ERROR', 'Internal server error.', undefined, { cause: error });
}

export function sendError(req: Request, res: Response, error: AppError): void {
  if (res.headersSent) return;
  const status = HTTP_STATUS[error.code];
  if (status === 401) res.setHeader('WWW-Authenticate', wwwAuthenticate(error));
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      // 5xx messages are generic: internals never leak to clients.
      message: error.code === 'INTERNAL_ERROR' ? 'Internal server error.' : error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      requestId: requestIdOf(req),
    },
  };
  res.status(status).json(body);
}

/** Centralized error handler: every failure becomes a structured JSON error. */
export function errorHandler(logger: Logger, bodyLimitBytes: number): ErrorRequestHandler {
  return (error: unknown, req, res, _next) => {
    const appError = toAppError(error, bodyLimitBytes);
    const status = HTTP_STATUS[appError.code];
    const log = (req.log as Logger | undefined) ?? logger;
    if (status >= 500) {
      log.error({ err: error, code: appError.code }, 'request failed');
    } else {
      log.info({ code: appError.code, reason: appError.message }, 'request rejected');
    }
    try {
      sendError(req, res, appError);
    } catch (sendFailure) {
      // Never fall back to Express's default HTML error page.
      log.error({ err: sendFailure }, 'failed to send error response');
      if (!res.headersSent) {
        res.removeHeader('WWW-Authenticate');
        res.status(500).json({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error.',
            requestId: requestIdOf(req),
          },
        });
      }
    }
  };
}
