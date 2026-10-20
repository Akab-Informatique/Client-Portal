import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { body } from "../lib/validate.ts";
import { isWorkflowKey, mailReady, recentRuns, runCounts, sendTest, setWorkflow, workflowState, WORKFLOWS, type WorkflowKey } from "../lib/workflows.ts";

/** Admin › Flux de travail (admin.workflows): switch the automatic workflows on and off, see what they did. */
export const workflowRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("admin.workflows"))

  .get("/", async (c) => {
    const ready = await mailReady();
    const list = await Promise.all(
      WORKFLOWS.map(async (w) => ({ key: w.key, template: w.template, ...(await workflowState(w.key)), counts: await runCounts(w.key) })),
    );
    return c.json({ mailReady: ready, workflows: list });
  })

  /** Switch on (it acts on the tickets made from now on) or off. */
  .put("/:key", async (c) => {
    const a = auth(c);
    const key = keyOf(c.req.param("key"));
    const p = await body(c, z.object({ enabled: z.boolean() }));
    // nothing to send with: never switched on blind
    if (p.enabled && !(await mailReady())) throw new HTTPException(409, { message: "mail_not_configured" });
    const state = await setWorkflow(key, p.enabled, a.user.id);
    await audit(a.user.id, p.enabled ? "workflow.enabled" : "workflow.disabled", key, {});
    return c.json(state);
  })

  .get("/:key/runs", async (c) => c.json(await recentRuns(keyOf(c.req.param("key")))))

  /** The message as the contact would get it (sample data), to your own address. */
  .post("/:key/test", async (c) => {
    const a = auth(c);
    const key = keyOf(c.req.param("key"));
    if (!rateLimit(`workflow-test:${a.user.id}`, 10, 3_600_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const ok = await sendTest(key, { email: a.realUser.email, locale: a.user.locale });
    await audit(a.user.id, "workflow.test", key, {});
    if (!ok) throw new HTTPException(502, { message: "mail_failed" });
    return c.json({ ok: true, to: a.realUser.email });
  });

function keyOf(raw: string): WorkflowKey {
  if (!isWorkflowKey(raw)) throw new HTTPException(404, { message: "not_found" });
  return raw;
}
