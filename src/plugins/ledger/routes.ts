/** The ledger's routes: the hourly reconcile (cron), revbound dev's local tick, and what the Runs view and the Overview read (session GET). */
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

const STATUSES = ["admitted", "running", "completed", "failed", "cancelled", "unknown", "refused", "start_failed", "not_started"];
const PERIODS: Record<string, string> = { day: "1 day", week: "7 days", month: "30 days" };
const ID = /^[0-9a-f-]{36}$/i;
const COLUMNS = sql`r.id, r.sdk_run_id, r.workflow, r.trigger, r.preview, r.status, r.reason, r.parent_run_id, r.root_run_id,
  r.approved_max_usd::float8 as approved_max_usd, r.approval_note, r.started_at, r.finished_at,
  to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
  coalesce(c.cost_usd, 0)::float8 as cost_usd, coalesce(c.calls, 0)::int as calls, coalesce(c.unmetered, 0)::int as unmetered`;
const FROM = sql`from revbound_ledger.runs r left join revbound_ledger.run_costs c on c.run_id = r.id`;
const toRun = (r: Record<string, any>) => ({
  id: r.id, sdkRunId: r.sdk_run_id, workflow: r.workflow, trigger: r.trigger, preview: r.preview, status: r.status, reason: r.reason,
  parentRunId: r.parent_run_id, rootRunId: r.root_run_id, approvedMaxUsd: r.approved_max_usd, approvalNote: r.approval_note,
  startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  costUsd: r.cost_usd, calls: r.calls, unmetered: r.unmetered,
});
const where = () => ({ local: !isHosted(), environment: environment() });
type Row = Record<string, any>;
type Run = ReturnType<typeof toRun>;
/** A query's rows. Typed here, since a project's own copy of this plugin sees the database slot untyped. */
const read = async (ctx: RouteCtx, q: ReturnType<typeof sql>): Promise<Row[]> => (await ctx.get("database").db().execute(q)).rows as Row[];

/**
 * GET /ledger/runs?workflow=&group=&status=&period=&q=&before= → { data, hasMore, next, local, environment }: 50 ledger runs a page, newest
 * first, with their cost and approval; `next` is the next page's `before` (the last row's exact start time and id). `status=not_started`
 * is every start that was refused or failed; `group` is every workflow of that group in the registry. Each read runs a reconcile pass after the response (throttled to one a minute).
 */
export async function runs(req: Request, ctx: RouteCtx): Promise<Response> {
  const p = new URL(req.url).searchParams, cond = [sql`true`];
  const workflow = p.get("workflow"), status = p.get("status"), period = PERIODS[p.get("period") ?? ""], q = p.get("q")?.trim(), before = p.get("before");
  if (status && !STATUSES.includes(status)) throw new HttpError(400, "Unknown status");
  if (workflow) cond.push(sql`r.workflow = ${workflow}`);
  if (p.get("group")) {
    const all = ctx.has("workflows") ? await ctx.get("workflows").registry() : {}, names = Object.keys(all).filter((n) => all[n].group === p.get("group"));
    cond.push(names.length ? sql`r.workflow in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})` : sql`false`);
  }
  if (status) cond.push(status === "not_started" ? sql`r.status in ('refused', 'start_failed')` : sql`r.status = ${status}`);
  if (period) cond.push(sql`r.started_at >= now() - ${period}::interval`);
  if (q) cond.push(sql`(r.id::text ilike ${`%${q}%`} or r.workflow ilike ${`%${q}%`} or r.sdk_run_id ilike ${`%${q}%`})`);
  if (before) {
    const [at, id] = before.split("~");
    if (Number.isNaN(Date.parse(at)) || (id !== undefined && !ID.test(id))) throw new HttpError(400, "before must be a time, or a page's next");
    cond.push(id ? sql`(r.started_at, r.id) < (${at}::timestamptz, ${id}::uuid)` : sql`r.started_at < ${at}::timestamptz`);
  }
  const rows = await read(ctx, sql`select ${COLUMNS} ${FROM} where ${sql.join(cond, sql` and `)} order by r.started_at desc, r.id desc limit 51`);
  after(() => ctx.get("ledger").reconcile().catch((e: Error) => console.error("[revbound] reconcile failed", e)));
  const last = rows.length > 50 ? rows[49] : undefined;
  return json({ data: rows.slice(0, 50).map(toRun), hasMore: !!last, next: last ? `${last.at}~${last.id}` : null, ...where() });
}

/**
 * GET /ledger/runs/<id> → { run, parent, children, result, local, environment }: one run with its status fresh, the run that
 * started it, the runs it started, and what it returned once completed (a declared key's value reads [redacted]).
 */
export async function run(_req: Request, ctx: RouteCtx): Promise<Response> {
  const ledger = ctx.get("ledger"), id = ctx.params.id;
  const row = ID.test(id) ? await ledger.refreshRun(id) : null;
  if (!row) throw new HttpError(404, "No such run");
  const tree = row.parentRunId || row.rootRunId === row.id ? await ledger.getTree(row.rootRunId) : [];
  const sdk = row.sdkRunId && row.status === "completed" && ctx.has("workflows") ? await ctx.get("workflows").getRun(row.sdkRunId, { values: true }).catch(() => null) : null;
  let result = sdk?.returnValue === undefined || sdk.returnValue === null ? null : JSON.stringify(sdk.returnValue, null, 2);
  for (const c of ctx.manifest.connections) {
    const v = process.env[c.name];
    if (result && v && v.length >= 4) result = result.replaceAll(v, "[redacted]");
  }
  return json({ run: row, parent: tree.find((r) => r.id === row.parentRunId) ?? null, children: tree.filter((r) => r.parentRunId === row.id), result, ...where() });
}

/**
 * GET /ledger/summary → { attention, running, recent, spend, groups, local }: what the Overview shows. `attention` is each workflow
 * whose newest real run (no preview, no child) failed or did not start; `spend` is this month's (UTC) total against the
 * project's budget, and per workflow with the budget its registry entry sets; `groups` is each grouped workflow's group.
 */
export async function summary(_req: Request, ctx: RouteCtx): Promise<Response> {
  const list = async (q: ReturnType<typeof sql>): Promise<Run[]> => (await read(ctx, q)).map(toRun);
  const [latest, running, recent, spent, registry, limits] = await Promise.all([
    lastRuns(ctx).then((m) => [...m.values()]),
    list(sql`select ${COLUMNS} ${FROM} where r.status in ('admitted', 'running') order by r.started_at desc limit 20`),
    list(sql`select ${COLUMNS} ${FROM} where r.parent_run_id is null order by r.started_at desc, r.id desc limit 5`),
    read(ctx, sql`select workflow, coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8 as usd from revbound_ledger.actions
      where created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' group by workflow`),
    ctx.has("workflows") ? ctx.get("workflows").registry().catch(() => ({})) : {},
    ctx.get("ledger").limitsFor("").catch(() => null),
  ]);
  const usd = new Map<string, number>(spent.map((r) => [String(r.workflow), Number(r.usd)]));
  const budgets = registry as Record<string, { group?: string; budget?: { perMonthUsd?: number } }>;
  const names = [...new Set([...usd.keys(), ...Object.keys(budgets).filter((n) => budgets[n].budget?.perMonthUsd != null)])].sort();
  return json({
    attention: latest.filter((r) => (r.status === "failed" || r.status === "start_failed") && (!ctx.has("workflows") || r.workflow in budgets)), running, recent,
    spend: { usd: [...usd.values()].reduce((a, b) => a + b, 0), budgetUsd: limits?.projectMonthUsd ?? null,
      workflows: names.map((n) => ({ workflow: n, usd: usd.get(n) ?? 0, budgetUsd: budgets[n]?.budget?.perMonthUsd ?? null })) },
    groups: Object.fromEntries(Object.entries(budgets).flatMap(([n, w]) => (w.group ? [[n, w.group]] : []))),
    local: !isHosted(),
  });
}

/** Each workflow's newest real run (no preview, no child), refused starts included: what the Workflows list shows. */
export async function lastRuns(ctx: RouteCtx): Promise<Map<string, Run>> {
  const rows = await read(ctx, sql`select distinct on (r.workflow) ${COLUMNS} ${FROM}
    where r.parent_run_id is null and not r.preview order by r.workflow, r.started_at desc, r.id desc`);
  return new Map<string, Run>(rows.map((r) => [String(r.workflow), toRun(r)]));
}
