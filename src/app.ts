import express, { type Express, type RequestHandler } from 'express';
import type { RateLimitPolicyName } from './config/env.js';
import type { Container } from './container.js';
import { metricsRoutes } from './modules/analytics/controllers/metrics.controller.js';
import { adminChatRoutes, chatRoutes } from './modules/chat/controllers/chat.controller.js';
import { authRoutes } from './modules/identity/controllers/auth.controller.js';
import {
  adminSubscriptionRoutes,
  subscriptionRoutes,
} from './modules/subscriptions/controllers/subscriptions.controller.js';
import type { Role } from './shared/domain/actor.js';
import { AppError } from './shared/domain/errors.js';
import { errorHandler } from './shared/infrastructure/http/errors.js';
import { healthRoutes } from './shared/infrastructure/http/health.controller.js';
import { rateLimit } from './shared/infrastructure/http/rate-limit.js';
import { requestLogging } from './shared/infrastructure/http/request-logging.js';
import {
  corsPolicy,
  requestTimeout,
  securityHeaders,
  strictJsonContentType,
} from './shared/infrastructure/http/security-middleware.js';
import { authenticate, requireRole } from './shared/infrastructure/security/authenticate.js';

const USER_OR_ADMIN: Role[] = ['user', 'admin'];
const ADMIN_ONLY: Role[] = ['admin'];

const routeNotFound: RequestHandler = (req) => {
  throw new AppError('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}.`);
};

/**
 * Builds the HTTP application. Middleware order matters:
 *
 *   request id + access log -> security headers -> global per-IP limit -> CORS
 *   -> timeout -> content type + body limit
 *   -> per route group: per-IP limit -> authentication (token + DPoP + session)
 *      -> per-user limit -> role gate -> controller (schema validation)
 *   -> centralized error handler
 *
 * Every route, including health and unknown paths, sits behind authentication;
 * only genuine CORS preflights are answered before it.
 */
export function buildApp(container: Container): Express {
  const { config, rateLimitStore: store, rateLimitClock: now } = container;
  const { windowMs, policies } = config.rateLimit;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);
  app.set('etag', false);
  app.set('query parser', 'simple');

  app.use(requestLogging(container.logger));
  app.use(...securityHeaders());
  app.use(
    rateLimit(
      { policy: 'global', scope: 'ip', limit: config.rateLimit.globalPerIp, windowMs },
      store,
      now,
    ),
  );
  app.use(...corsPolicy(config.server.corsAllowedOrigins));
  app.use(requestTimeout(config.server.requestTimeoutMs));
  app.use(strictJsonContentType());
  app.use(
    express.json({
      limit: config.server.bodyLimitBytes,
      strict: true,
      type: 'application/json',
      inflate: false,
    }),
  );

  const authn = authenticate(container.auth);
  const protect = (policy: RateLimitPolicyName, roles: Role[]): RequestHandler[] => [
    rateLimit({ policy, scope: 'ip', limit: policies[policy].perIp, windowMs }, store, now),
    authn,
    rateLimit({ policy, scope: 'user', limit: policies[policy].perUser, windowMs }, store, now),
    requireRole(...roles),
  ];

  const api = express.Router();
  api.use(
    '/auth',
    ...protect('auth', USER_OR_ADMIN),
    authRoutes({ sessions: container.auth.sessions, clock: container.clock }),
  );
  api.use('/chat', ...protect('chat', USER_OR_ADMIN), chatRoutes(container.chat));
  api.use(
    '/subscriptions',
    ...protect('subscriptions', USER_OR_ADMIN),
    subscriptionRoutes(container.subscriptions),
  );
  api.use(
    '/admin',
    ...protect('admin', ADMIN_ONLY),
    adminChatRoutes(container.chat),
    adminSubscriptionRoutes(container.subscriptions),
    metricsRoutes(container.analytics),
  );
  api.use(
    '/health',
    ...protect('system', USER_OR_ADMIN),
    healthRoutes({ db: container.db, startedAt: container.startedAt }),
  );
  app.use('/api/v1', api);

  // Unknown paths authenticate first: anonymous callers learn nothing about routing.
  app.use(authn, routeNotFound);
  app.use(errorHandler(container.logger, config.server.bodyLimitBytes));
  return app;
}
