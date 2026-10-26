/** The inbound webhook route, kept apart so `revbound check` can load it to see its brand. */
import { sql } from "drizzle-orm";
import type { RouteCtx } from "revbound";
import { brand, HttpError, isBranded, json } from "revbound/kit";
import type { Webhook, Webhooks } from "./runtime.js";

/**
 * POST /hooks/<name> (signature): verify, claim the sender's event id once, then onEvent. A repeat delivery answers 200
 * without onEvent; a throwing onEvent releases its claim and answers 500, so the sender retries.
 */
const hooks = brand(async (req: Request, ctx: RouteCtx): Promise<Response> => {
  const name = ctx.params.name, all = await ctx.module<Webhooks>("webhooks");
  const hook: Webhook | undefined = Object.hasOwn(all, name) ? all[name] : undefined;
  if (!hook) throw new HttpError(404, `No webhook named "${name}" in webhooks/index.ts`);
  if (!isBranded(hook)) throw new HttpError(500, `The webhook ${name} is not built with webhook(), so it is refused.`);
  const raw = await req.text();
  if (!(await hook.verify(req, raw))) throw new HttpError(401, "The signature does not verify.");
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch {}
  const key = String(await hook.dedupe(req, body));
  const db = ctx.get("database").db();
  const claimed = await db.execute(sql`insert into gtm_workflows.webhook_events (hook, dedupe_key, outcome) values (${name}, ${key}, 'claimed') on conflict do nothing returning hook`);
  if (!claimed.rows.length) return json({ ok: true, duplicate: true });
  let runId: string | null = null;
  try {
    const outcome = await hook.onEvent({
      body, req,
      start: async (workflow, input) => {
        const r = await ctx.get("workflows").start(workflow, input, { trigger: "webhook" });
        if (!r.ok) throw new HttpError(403, r.reason);
        runId ??= r.runId;
        return { runId: r.runId };
      },
    });
    if (outcome && typeof outcome === "object") runId ??= outcome.runId;
    await db.execute(sql`update gtm_workflows.webhook_events set outcome = ${outcome === "ignored" ? "ignored" : "handled"}, run_id = ${runId} where hook = ${name} and dedupe_key = ${key}`);
    return json({ ok: true, ...(runId && { runId }) });
  } catch (error) {
    await db.execute(sql`delete from gtm_workflows.webhook_events where hook = ${name} and dedupe_key = ${key} and outcome = 'claimed'`).catch(() => {});
    if (error instanceof HttpError) throw error;
    console.error(`[revbound] webhook ${name} failed`, error);
    throw new HttpError(500, "The webhook failed; the sender may retry.");
  }
});

export default hooks;
