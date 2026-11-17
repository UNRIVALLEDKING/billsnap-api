import type { z } from "zod";
import { AppError } from "../platform/errors";

export const validationFailed = (detail = "Invalid request") =>
  new AppError("validation_failed", 422, detail);

/** Validates `value` against `schema`; any problem is a 422 `validation_failed` (field paths, never values). */
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const where = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`)
    .join("; ");
  throw validationFailed(`Invalid request: ${where}`);
}

export async function parseJsonBody<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  return validate(schema, await req.json().catch(() => undefined));
}
