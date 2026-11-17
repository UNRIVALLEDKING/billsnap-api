import { badRequest } from "../platform/errors";

export type Cursor = { createdAt: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque keyset cursor over (created_at, id). `createdAt` is an ISO-8601 timestamp. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id])).toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed;
      if (
        typeof createdAt === "string" &&
        !Number.isNaN(Date.parse(createdAt)) &&
        typeof id === "string" &&
        UUID.test(id)
      ) {
        return { createdAt, id };
      }
    }
  } catch {
    // fall through to the 400 below
  }
  throw badRequest("Invalid cursor");
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}
