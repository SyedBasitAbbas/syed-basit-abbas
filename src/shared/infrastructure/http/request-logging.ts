import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Full path without the query string (routers rewrite req.url, not originalUrl). */
function pathOf(req: { url?: string; originalUrl?: string }): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
}

/**
 * Structured access log with request id, user id and response time.
 * A well-formed incoming X-Request-Id is reused (for tracing across services);
 * anything else is replaced with a fresh UUID. The id is echoed back.
 */
export function requestLogging(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'responseTimeMs' },
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Evaluated at request start and again at completion; only the second call
    // knows the authenticated user, so emit the key only when it is known.
    customProps: (_req, res) => {
      const userId = (res as Response).locals.auth?.actor.userId;
      return userId ? { userId } : {};
    },
    serializers: {
      req: (req: Request & { raw?: Request }) => ({
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        ip: req.raw?.ip ?? req.ip,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode}`,
  });
}
