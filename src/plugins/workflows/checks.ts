/** The workflows plugin's checks: the registry's entries, their approvals, budgets and schedules, crons and webhooks. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Registry } from "revbound";
import { type CheckCtx, projectJiti } from "revbound/cli";
import { isBranded } from "revbound/kit";
import { cronSchedules } from "revbound/kit/scan";

const KEYS = new Set(["run", "description", "tables", "connections", "diagram", "approval", "budget", "schedule"]);
const DAY = 86_400_000;
const positive = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0);

export default async function checks(ctx: CheckCtx): Promise<CheckResult[]> {
  const out: CheckResult[] = [], opts = (ctx.options ?? {}) as { registry?: string; webhooks?: string };
  const err = (message: string, fix?: string) => out.push({ level: "error", message, fix });
  const warn = (message: string) => out.push({ level: "warning", message });
  const load = async (path: string, name: string) => {
    const mod = (await projectJiti(ctx.dir).import(join(ctx.dir, path))) as Record<string, unknown>;
    return mod[name];
  };
  const DOCS = "`npx revbound docs workflows`";
  let registry: Registry;
  try {
    registry = (await load(opts.registry ?? "./workflows", "workflows")) as Registry;
    if (!registry || typeof registry !== "object") throw new Error("it does not export `workflows`");
  } catch (error) {
    err(`workflows/index.ts does not load: ${(error as Error).message}`, `export const workflows = { <name>: workflowFn } (${DOCS})`);
    return out;
  }
  for (const [name, e] of Object.entries(registry)) {
    const at = `workflows/index.ts: ${name}`;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) err(`${at}: the name must be lowercase letters, digits and -.`);
    if (typeof e === "function") continue;
    if (!e || typeof e !== "object" || typeof e.run !== "function") { err(`${at} is neither a workflow function nor { run: workflowFn, … }.`, DOCS); continue; }
    for (const k of Object.keys(e)) if (!KEYS.has(k)) err(`${at} has an unknown field "${k}".`, `use only ${[...KEYS].join(", ")}`);
    if (e.approval !== undefined) {
      const a = e.approval as Record<string, unknown>;
      if (a.required !== true) err(`${at}: approval needs \`required: true\`.`);
      for (const k of ["previewItems", "previewCalls", "previewMaxUsd", "previewWithinHours"]) if (!positive(a[k])) err(`${at}: approval.${k} must be a positive number.`);
    }
    if (e.budget !== undefined) for (const k of ["perRunUsd", "perMonthUsd"] as const) if (!positive(e.budget[k])) err(`${at}: budget.${k} must be a positive number of dollars.`);
    if (e.schedule !== undefined) {
      if (!e.budget?.perRunUsd || !e.budget?.perMonthUsd) err(`${at}: a schedule needs budget.perRunUsd and budget.perMonthUsd.`, "quote cost per run × runs per month, get a yes, then commit both next to the schedule (`npx revbound docs ledger`)");
      const until = Date.parse(e.schedule.approvedUntil ?? "");
      if (!/^\d{4}-\d{2}-\d{2}/.test(e.schedule.approvedUntil ?? "") || Number.isNaN(until)) err(`${at}: schedule.approvedUntil must be an ISO date (2026-12-31).`);
      else if (until + DAY <= Date.now()) warn(`${at}: its schedule approval ended on ${e.schedule.approvedUntil}, so cron starts are refused until a new yes.`);
      else if (until - Date.now() < 14 * DAY) warn(`${at}: its schedule approval ends on ${e.schedule.approvedUntil}; ask for a new yes before then.`);
      if (typeof e.schedule.note !== "string" || !e.schedule.note.trim()) err(`${at}: schedule.note must say what the person approved.`);
    }
  }
  let crons: ReturnType<typeof cronSchedules> = [];
  try { JSON.parse(readFileSync(join(ctx.dir, "vercel.json"), "utf8")); crons = cronSchedules(ctx.dir); } catch { err("vercel.json is not valid JSON."); }
  for (const c of crons) {
    const e = registry[c.workflow];
    if (!e) err(`vercel.json schedules /api/revbound/cron/${c.workflow}, which is not in workflows/index.ts.`, "register the workflow or remove the cron");
    else if (typeof e !== "function" && e.approval?.required && !e.schedule) warn(`vercel.json schedules ${c.workflow}, which needs approval and has no schedule approval, so its cron starts are refused.`);
  }
  try {
    const hooks = (await load(opts.webhooks ?? "./webhooks", "webhooks")) as Record<string, unknown> | undefined;
    for (const [name, h] of Object.entries(hooks ?? {})) if (!isBranded(h)) err(`webhooks/index.ts: ${name} is not built with webhook() from #revbound/workflows.`, "wrap it in webhook({ verify, dedupe, onEvent })");
  } catch (error) {
    err(`webhooks/index.ts does not load: ${(error as Error).message}`, "export const webhooks = { <name>: webhook({ … }) } (`npx revbound docs webhooks`)");
  }
  return out;
}
