import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../domain/actor.js';
import { AppError, type ValidationIssue } from '../../domain/errors.js';
import type { AuthContext } from '../security/authenticate.js';
import { requestIdOf } from './errors.js';

export interface EndpointContext<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  actor: Actor;
  auth: AuthContext;
  requestId: string;
  /** Aborted when the global request timeout fires. */
  signal: AbortSignal;
}

export interface EndpointResult {
  status: number;
  body?: unknown;
}

interface EndpointSchemas<B, Q, P> {
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  params?: z.ZodType<P>;
}

type InputLocation = ValidationIssue['location'];

const NEVER_ABORTED = new AbortController().signal;

function validationError(issues: ValidationIssue[]): AppError {
  return new AppError('VALIDATION_FAILED', 'Request validation failed.', { issues });
}

function parse<T>(schema: z.ZodType<T>, input: unknown, location: InputLocation): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((issue) => ({
        location,
        path: issue.path.map(String).join('.'),
        message: issue.message,
        code: issue.code,
      })),
    );
  }
  return result.data;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

function readBody<B>(req: Request, schema: z.ZodType<B> | undefined): B {
  if (schema) return parse(schema, req.body, 'body');
  if (req.body !== undefined && !isEmptyObject(req.body)) {
    throw new AppError('BODY_NOT_ALLOWED', 'This endpoint does not accept a request body.');
  }
  return undefined as B;
}

function readQuery<Q>(req: Request, schema: z.ZodType<Q> | undefined): Q {
  if (schema) return parse(schema, req.query, 'query');
  const unknownKeys = Object.keys(req.query);
  if (unknownKeys.length > 0) {
    throw validationError(
      unknownKeys.map((key) => ({
        location: 'query',
        path: key,
        message: 'Unknown query parameter',
        code: 'unrecognized_keys',
      })),
    );
  }
  return undefined as Q;
}

/**
 * Wraps a controller action:
 * - refuses to run without an authenticated principal (a second guard behind the router);
 * - validates body, query and params against strict zod schemas, so unknown fields are
 *   rejected (no mass assignment) and handlers receive typed input;
 * - endpoints that declare no body or query reject any body or query sent anyway.
 */
export function endpoint<B = undefined, Q = undefined, P = undefined>(
  schemas: EndpointSchemas<B, Q, P>,
  handler: (context: EndpointContext<B, Q, P>) => Promise<EndpointResult>,
): RequestHandler {
  return async (req, res) => {
    const auth = res.locals.auth;
    if (!auth) throw new AppError('UNAUTHENTICATED', 'Authentication required.');

    const result = await handler({
      body: readBody(req, schemas.body),
      query: readQuery(req, schemas.query),
      params: schemas.params ? parse(schemas.params, req.params, 'params') : (undefined as P),
      actor: auth.actor,
      auth,
      requestId: requestIdOf(req),
      signal: res.locals.abortSignal ?? NEVER_ABORTED,
    });

    if (res.headersSent) return; // the request timeout already answered
    if (result.body === undefined) {
      res.status(result.status).end();
    } else {
      res.status(result.status).json(result.body);
    }
  };
}
