import cors from 'cors';
import type { Request, RequestHandler } from 'express';
import helmet from 'helmet';
import { AppError } from '../../domain/errors.js';
import { sendError } from './errors.js';

/** Secure response headers for a JSON-only API. */
export function securityHeaders(): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      frameguard: { action: 'deny' },
      xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      next();
    },
  ];
}

/**
 * Restricted CORS: only explicitly listed origins, no credentials, a fixed set
 * of methods and headers. Requests from any other browser origin are refused
 * with 403 instead of merely lacking CORS headers.
 */
export function corsPolicy(allowedOrigins: readonly string[]): RequestHandler[] {
  const allowed = new Set(allowedOrigins);
  const guard: RequestHandler = (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      throw new AppError('CORS_ORIGIN_DENIED', 'This origin is not allowed to call the API.');
    }
    next();
  };
  const corsHandler = cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    methods: ['GET', 'POST', 'PATCH'],
    allowedHeaders: ['Authorization', 'DPoP', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: [
      'X-Request-Id',
      'WWW-Authenticate',
      'Retry-After',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ],
    credentials: false,
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
  // Only genuine browser preflights are answered without authentication; any
  // other OPTIONS request continues into the authenticated pipeline.
  const preflight: RequestHandler = (req, res, next) => {
    const isPreflight =
      req.method === 'OPTIONS' &&
      req.headers.origin !== undefined &&
      req.headers['access-control-request-method'] !== undefined;
    if (req.method === 'OPTIONS' && !isPreflight) {
      next();
      return;
    }
    corsHandler(req, res, next);
  };
  return [guard, preflight];
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function isJsonUtf8(contentType: string): boolean {
  const [mediaType, ...parameters] = contentType
    .split(';')
    .map((part) => part.trim().toLowerCase());
  if (mediaType !== 'application/json') return false;
  return parameters.every((parameter) => parameter === 'charset=utf-8' || parameter === '');
}

/**
 * Strict content-type validation: bodies are only allowed on POST/PATCH/PUT and
 * must be `application/json` (optionally `; charset=utf-8`).
 */
export function strictJsonContentType(): RequestHandler {
  return (req, _res, next) => {
    if (!hasBody(req)) {
      next();
      return;
    }
    if (!['POST', 'PATCH', 'PUT'].includes(req.method)) {
      throw new AppError('BODY_NOT_ALLOWED', `${req.method} requests must not carry a body.`);
    }
    const contentType = req.headers['content-type'];
    if (!contentType || !isJsonUtf8(contentType)) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Request bodies must be JSON sent with "Content-Type: application/json".',
      );
    }
    next();
  };
}

/** How long a timed-out handler gets to report its own outcome before we answer for it. */
const TIMEOUT_GRACE_MS = 500;

/**
 * Global request timeout. When it fires, the abort signal handed to use cases is
 * triggered, so work in progress (such as the AI call) is cancelled and its
 * reserved quota refunded. The handler then reports the timeout itself; only if
 * it is stuck does this middleware send the structured 503 on its behalf.
 */
export function requestTimeout(timeoutMs: number): RequestHandler {
  return (req, res, next) => {
    const controller = new AbortController();
    res.locals.abortSignal = controller.signal;
    let fallback: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      const error = new AppError(
        'REQUEST_TIMEOUT',
        `The request did not finish within ${timeoutMs} ms.`,
        {
          timeoutMs,
        },
      );
      controller.abort(error);
      fallback = setTimeout(() => {
        sendError(req, res, error);
      }, TIMEOUT_GRACE_MS);
      fallback.unref();
    }, timeoutMs);
    timer.unref();

    const clear = () => {
      clearTimeout(timer);
      clearTimeout(fallback);
    };
    res.once('finish', clear);
    res.once('close', clear);
    next();
  };
}
