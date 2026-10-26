/** The workflows plugin's routes. Every start goes through the workflows slot, and so through the ledger. */
import type { Admission, LedgerRun, Registry, RouteCtx } from "revbound";
import { HttpError, json } from "revbound/kit";
import { inspector as serveInspector } from "./inspector.js";
import { aboutOf, lastRuns, schedules, source } from "./sdk.js";

function refused(a: Extract<Admission, { ok: false }>): Response {
  return json({ error: a.reason, ...(a.runId && { runId: a.runId }) }, 403);
}

/** GET /workflows (session) → { workflows: [{ name, schedule, lastRun, file, sourceUrl, ...About }], runsKnown }. */
export async function list(_req: Request, ctx: RouteCtx): Promise<Response> {
  const workflows = await ctx.module<Registry>("registry"), crons = schedules();
  const last = await lastRuns(workflows).catch((error) => { console.error("[revbound] could not list workflow runs", error); return null; });
  return json({
    workflows: Object.entries(workflows).map(([name, e]) => {
      const r = last?.get(name);
      return { name, cron: crons.get(name) ?? null, lastRun: r ? { id: r.sdkRunId, status: r.status, createdAt: r.createdAt, completedAt: r.completedAt } : null,
        ...source(workflows, name), ...aboutOf(e) };
    }),
    runsKnown: last != null,
  });
}

/**
 * POST /start/<name> (automation) with `{ input?, preview?, approve?: { maxUsd, note? } }` → { runId, rootId, sdkRunId }.
 * `x-revbound-client: cli` marks a start from `revbound run`. A refusal answers 403 with the ledger's reason.
 */
export async function start(req: Request, ctx: RouteCtx): Promise<Response> {
  const text = (await req.text()).trim();
  let body: { input?: unknown; preview?: unknown; approve?: { maxUsd?: unknown; note?: unknown } };
  try { body = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "The body must be JSON: { input, preview, approve }."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "The body must be a JSON object: { input, preview, approve }.");
  const approve = body.approve;
  if (approve !== undefined && (typeof approve !== "object" || typeof approve?.maxUsd !== "number" || !(approve.maxUsd > 0))) {
    throw new HttpError(400, "approve needs maxUsd, a positive number of dollars (--approve --max-usd <n>).");
  }
  const r = await ctx.get("workflows").start(ctx.params.name, body.input, {
    trigger: req.headers.get("x-revbound-client") === "cli" ? "cli" : "http", preview: body.preview === true,
    ...(approve && { approve: { maxUsd: approve.maxUsd as number, ...(typeof approve.note === "string" && { note: approve.note }) } }),
  });
  if (!r.ok) return refused(r);
  return json({ runId: r.runId, rootId: r.rootId, sdkRunId: r.sdkRunId ?? null, preview: r.preview });
}

/** A ledger row with the SDK's return value and error, once final. */
async function withValues(ctx: RouteCtx, row: LedgerRun) {
  const sdk = row.sdkRunId && ["completed", "failed"].includes(row.status) ? await ctx.get("workflows").getRun(row.sdkRunId, { values: true }).catch(() => null) : null;
  return { ...row, returnValue: sdk?.returnValue ?? null, error: sdk?.error ?? (row.status === "failed" || row.status === "refused" || row.status === "start_failed" ? row.reason : null) };
}

/**
 * GET /runs/<revbound run id> (automation) → { run, tree?, final, costUsd, unmetered }: the run (status refreshed from the SDK)
 * with its return value; `?tree=1` adds every run of its tree. `final` is true once the whole tree is.
 */
export async function status(req: Request, ctx: RouteCtx): Promise<Response> {
  const ledger = ctx.get("ledger"), id = ctx.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, `No run ${id}`);
  const row = await ledger.refreshRun(id);
  if (!row) throw new HttpError(404, `No run ${id}`);
  const open = (r: LedgerRun) => r.status === "admitted" || r.status === "running";
  if (new URL(req.url).searchParams.get("tree") !== "1") return json({ run: await withValues(ctx, row), final: !open(row), costUsd: row.costUsd, unmetered: row.unmetered });
  let tree = await ledger.getTree(row.rootRunId);
  await Promise.all(tree.filter(open).map((r) => ledger.refreshRun(r.id)));
  tree = await ledger.getTree(row.rootRunId);
  const runs = await Promise.all(tree.map((r) => withValues(ctx, r)));
  const cost = tree.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  return json({ run: runs.find((r) => r.id === id), tree: runs.filter((r) => r.id !== id), final: !tree.some(open), costUsd: Math.round(cost * 1e6) / 1e6, unmetered: tree.reduce((n, r) => n + r.unmetered, 0) });
}

/** GET /cron/<name> (cron) → { runId }: a schedule's start; the ledger checks a schedule approval in the registry. */
export async function cron(_req: Request, ctx: RouteCtx): Promise<Response> {
  const r = await ctx.get("workflows").start(ctx.params.name, undefined, { trigger: "cron" });
  if (!r.ok) return refused(r);
  return json({ runId: r.runId });
}

/** Any method on /inspector/* (local): the Workflow SDK's own run inspector. */
export async function inspector(req: Request): Promise<Response> {
  return serveInspector(req);
}
