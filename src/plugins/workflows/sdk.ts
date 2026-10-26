/** The Workflow SDK side of the workflows plugin: registry names ↔ workflow ids, runs from the World, schedules. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "workflow/api";
import { parseWorkflowName } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import type { About, Registry, RegistryEntry, RegistryInfo, SdkRun } from "revbound";
import { isHosted, value } from "revbound/kit";
import { cronSchedules } from "revbound/kit/scan";

type WorkflowFn = (...args: any[]) => Promise<unknown>;
export const runOf = (e: RegistryEntry | undefined) => (typeof e === "function" ? e : e?.run) as WorkflowFn | undefined;
export const aboutOf = (e: RegistryEntry): About & RegistryInfo => (typeof e === "function" ? {} : (({ run: _, ...rest }) => rest)(e));

/** workflowId (what runs record as workflowName; the SWC transform sets it on each function) ↔ registry name. */
export function ids(workflows: Registry) {
  const byId = new Map(Object.entries(workflows).map(([name, e]) => [(runOf(e) as { workflowId?: string } | undefined)?.workflowId ?? name, name]));
  const name = (id: string) => byId.get(id) ?? parseWorkflowName(id)?.shortName ?? id;
  return { name, id: (n: string) => [...byId].find(([, v]) => v === n)?.[0] };
}

/** A failed run's message (the cause WorkflowRunFailedError wraps). */
export const failure = (e: { cause?: { message?: unknown }; message?: string }) =>
  typeof e?.cause?.message === "string" ? e.cause.message : (e?.message ?? String(e));

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

type WorldRun = { runId: string; status: SdkRun["status"]; workflowName: string; createdAt: Date; completedAt?: Date | null; attributes?: Record<string, string> };

/** One SDK run, with its return value or error when `values` and final; null when the World no longer has it. */
export async function sdkRun(workflows: Registry, sdkId: string, values = false): Promise<SdkRun | null> {
  if (!/^[\w-]{1,128}$/.test(sdkId)) return null;
  const world = await getWorld();
  const r = (await world.runs.get(sdkId).catch((e: { status?: number; name?: string; message?: string }) => {
    if (e?.status === 404 || /not.?found/i.test(`${e?.name} ${e?.message}`)) return null;
    throw e;
  })) as WorldRun | null;
  if (!r) return null;
  const out: SdkRun = { sdkRunId: r.runId, workflow: ids(workflows).name(r.workflowName), status: r.status, createdAt: iso(r.createdAt)!,
    completedAt: iso(r.completedAt), attributes: r.attributes ?? {} };
  if (values && (r.status === "completed" || r.status === "failed")) {
    // Final, so returnValue settles on its first read; it also revives (and decrypts) the stored payload.
    out.returnValue = await getRun(sdkId).returnValue.then((v) => v ?? null, (e) => ((out.error = failure(e)), null));
    out.error ??= null;
  }
  return out;
}

/** Every SDK run created at or after `since` (ISO, or "-infinity"), newest first: it pages until it reaches `since`, so
 * reconcile's cursor never skips a run however many wait. */
export async function sdkRuns(workflows: Registry, since: string): Promise<SdkRun[]> {
  const world = await getWorld(), out: SdkRun[] = [], from = since === "-infinity" ? 0 : Date.parse(since);
  const { name } = ids(workflows);
  let cursor: string | undefined;
  for (;;) {
    const res = (await world.runs.list({ pagination: { limit: 100, sortOrder: "desc", ...(cursor && { cursor }) }, resolveData: "none" } as never)) as
      { data: WorldRun[]; cursor: string | null; hasMore: boolean };
    for (const r of res.data) {
      if (new Date(r.createdAt).getTime() < from) return out;
      out.push({ sdkRunId: r.runId, workflow: name(r.workflowName), status: r.status, createdAt: iso(r.createdAt)!, completedAt: iso(r.completedAt), attributes: r.attributes ?? {} });
    }
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

/** Each workflow's newest SDK run (undefined: none), six reads at a time. */
export async function lastRuns(workflows: Registry): Promise<Map<string, SdkRun>> {
  const world = await getWorld(), { id, name } = ids(workflows), names = Object.keys(workflows), out = new Map<string, SdkRun>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, names.length) }, async () => {
    while (next < names.length) {
      const n = names[next++];
      const page = (await world.runs.list({ pagination: { limit: 1, sortOrder: "desc" }, workflowName: id(n) ?? n, resolveData: "none" } as never)) as { data: WorldRun[] };
      const r = page.data[0];
      if (r) out.set(n, { sdkRunId: r.runId, workflow: name(r.workflowName), status: r.status, createdAt: iso(r.createdAt)!, completedAt: iso(r.completedAt), attributes: r.attributes ?? {} });
    }
  }));
  return out;
}

/** Workflow name → schedule: vercel.json crons on /api/revbound/cron/<name> unless hosted, then REVBOUND_CRONS baked at build. */
export function schedules(): Map<string, string> {
  // process.env.REVBOUND_CRONS literally, so the value the next transform inlines at build time is the one read.
  const crons: ReturnType<typeof cronSchedules> = isHosted() ? JSON.parse(process.env.REVBOUND_CRONS ?? "[]") : cronSchedules();
  const map = new Map<string, string>();
  for (const { workflow: w, schedule } of crons) map.set(w, map.has(w) ? `${map.get(w)}; ${schedule}` : schedule);
  return map;
}

/**
 * The workflow's source file from its workflowId (`workflow//./workflows/x//fn`): the path from the project root, and
 * its GitHub page at the deployed commit when hosted from GitHub.
 */
export function source(workflows: Registry, name: string) {
  const id = ids(workflows).id(name), spec = id ? parseWorkflowName(id)?.moduleSpecifier : undefined;
  if (!spec?.startsWith("./")) return { file: null, sourceUrl: null };
  const base = spec.slice(2), ext = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"].find((e) => existsSync(join(process.cwd(), base + e)));
  const file = base + (ext ?? ".ts"), [owner, repo, sha] = ["VERCEL_GIT_REPO_OWNER", "VERCEL_GIT_REPO_SLUG", "VERCEL_GIT_COMMIT_SHA"].map((k) => value(k));
  const github = isHosted() && value("VERCEL_GIT_PROVIDER") === "github" && owner && repo && sha;
  return { file, sourceUrl: github ? `https://github.com/${owner}/${repo}/blob/${sha}/${file.split("/").map(encodeURIComponent).join("/")}` : null };
}
