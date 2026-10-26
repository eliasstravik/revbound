/** The ledger's routes: the hourly reconcile (cron), revbound dev's local tick, and the Runs view (session GET). */
import { after } from "next/server.js";
import { sql } from "drizzle-orm";
import type { RouteCtx } from "revbound";
import { environment, HttpError, isHosted, json } from "revbound/kit";

/** GET /ledger/reconcile (cron, hourly in vercel.json) → the pass's counts. */
export async function reconcile(_req: Request, ctx: RouteCtx): Promise<Response> {
  return json(await ctx.get("ledger").reconcile());
}

/** POST /ledger/tick (local): revbound dev's 60-second reconcile, since crons never fire locally. */
export async function tick(_req: Request, ctx: RouteCtx): Promise<Response> {
  return json(await ctx.get("ledger").reconcile());
}

const STATUSES = ["admitted", "running", "completed", "failed", "cancelled", "unknown", "refused", "start_failed"];
const PERIODS: Record<string, string> = { day: "1 day", week: "7 days", month: "30 days" };

/**
 * GET /ledger/runs?workflow=&status=&period=&q=&before= → { data, hasMore, next, local, environment }: 50 ledger runs a page, newest
 * first, with their cost and approval; `next` is the next page's `before` (the last row's exact start time and id). Each read runs a reconcile pass after the response (throttled to one a minute).
 */
export async function runs(req: Request, ctx: RouteCtx): Promise<Response> {
  const p = new URL(req.url).searchParams, where = [sql`true`];
  const workflow = p.get("workflow"), status = p.get("status"), period = PERIODS[p.get("period") ?? ""], q = p.get("q")?.trim(), before = p.get("before");
  if (status && !STATUSES.includes(status)) throw new HttpError(400, "Unknown status");
  if (workflow) where.push(sql`r.workflow = ${workflow}`);
  if (status) where.push(sql`r.status = ${status}`);
  if (period) where.push(sql`r.started_at >= now() - ${period}::interval`);
  if (q) where.push(sql`(r.id::text ilike ${`%${q}%`} or r.workflow ilike ${`%${q}%`} or r.sdk_run_id ilike ${`%${q}%`})`);
  if (before) {
    const [at, id] = before.split("~");
    if (Number.isNaN(Date.parse(at)) || (id !== undefined && !/^[0-9a-f-]{36}$/i.test(id))) throw new HttpError(400, "before must be a time, or a page's next");
    where.push(id ? sql`(r.started_at, r.id) < (${at}::timestamptz, ${id}::uuid)` : sql`r.started_at < ${at}::timestamptz`);
  }
  const db = ctx.get("database").db();
  const { rows } = await db.execute(sql`select r.id, r.sdk_run_id, r.workflow, r.trigger, r.preview, r.status, r.reason, r.parent_run_id, r.root_run_id,
      r.approved_max_usd::float8 as approved_max_usd, r.approval_note, r.started_at, r.finished_at,
      to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
      coalesce(c.cost_usd, 0)::float8 as cost_usd, coalesce(c.calls, 0)::int as calls, coalesce(c.unmetered, 0)::int as unmetered
    from gtm_ledger.runs r left join gtm_ledger.run_costs c on c.run_id = r.id
    where ${sql.join(where, sql` and `)} order by r.started_at desc, r.id desc limit 51`);
  after(() => ctx.get("ledger").reconcile().catch((e: Error) => console.error("[revbound] reconcile failed", e)));
  const data = rows.slice(0, 50).map((r: Record<string, any>) => ({
    id: r.id, sdkRunId: r.sdk_run_id, workflow: r.workflow, trigger: r.trigger, preview: r.preview, status: r.status, reason: r.reason,
    parentRunId: r.parent_run_id, rootRunId: r.root_run_id, approvedMaxUsd: r.approved_max_usd, approvalNote: r.approval_note,
    startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    costUsd: r.cost_usd, calls: r.calls, unmetered: r.unmetered,
  }));
  const last = rows.length > 50 ? (rows[49] as Record<string, any>) : undefined;
  return json({ data, hasMore: !!last, next: last ? `${last.at}~${last.id}` : null, local: !isHosted(), environment: environment() });
}
