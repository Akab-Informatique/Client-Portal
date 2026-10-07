import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/** Parse a JSON body with a zod schema; 400 with field errors on failure. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON" });
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HTTPException(400, { message: "Validation failed", cause: fields });
  }
  return r.data;
}

export const zEmail = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());

export const zName = z.string().trim().min(1).max(120);
export const zOptText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional();
export const zUuid = z.uuid();
