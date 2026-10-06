import { z } from 'zod';
import type { Cursor } from '../../application/pagination.js';

/** Opaque keyset cursor: base64url(JSON {t: ISO timestamp, i: uuid}). */
export function encodeCursor(cursor: Cursor | null): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id })).toString(
    'base64url',
  );
}

const CursorPayload = z.strictObject({ t: z.iso.datetime(), i: z.uuid() });

export const cursorParam = z
  .string()
  .max(200)
  .transform((value, ctx): Cursor => {
    try {
      const decoded = CursorPayload.parse(
        JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
      );
      return { createdAt: new Date(decoded.t), id: decoded.i };
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
      return z.NEVER;
    }
  });

export const pageQueryShape = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: cursorParam.optional(),
};

export const PageQuery = z.strictObject(pageQueryShape);

export function toPageRequest(query: { limit: number; cursor?: Cursor | undefined }) {
  return { limit: query.limit, cursor: query.cursor ?? null };
}

export const uuidParam = z.uuid();
