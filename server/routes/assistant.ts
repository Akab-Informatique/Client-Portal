import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { answerChat } from "../lib/assistant.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { rateLimit } from "../lib/http.ts";
import { body } from "../lib/validate.ts";
import { aiHttpError } from "./tickets.ts";

/** The portal assistant (staff with assistant.use). The question is never stored; the audit keeps its length only. */
const zChat = z
  .object({
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(12),
  })
  .refine((v) => v.messages.at(-1)?.role === "user", { message: "last_must_be_user" });

export const assistantRoutes = new Hono<AppEnv>().post("/chat", requireStaff, requirePermission("assistant.use"), async (c) => {
  const a = auth(c);
  const p = await body(c, zChat);
  if (!rateLimit(`assistant:${a.user.id}`, 30, 60 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
  const question = p.messages.at(-1)?.content ?? "";
  let out;
  try {
    out = await answerChat({ auth: a, messages: p.messages });
  } catch (e) {
    throw aiHttpError(e);
  }
  await audit(a.user.id, "assistant.asked", null, { chars: question.length, tools: out.tools });
  return c.json({ answer: out.answer, sources: out.sources, tools: out.tools });
});
