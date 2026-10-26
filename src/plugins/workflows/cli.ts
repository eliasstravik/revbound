import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type CliCtx, loadEnv } from "revbound/cli";
import { appPort, basePath, value } from "revbound/kit";

const USAGE = "Usage: revbound run <workflow> [--input <json>] [--preview] [--approve --max-usd <n> [--note <text>]] [--prod] [--no-wait]";

type Row = { id: string; workflow: string; status: string; returnValue: unknown; error: string | null; costUsd: number | null; unmetered: number };

/**
 * `revbound run`: starts a run with POST /api/revbound/start/<workflow> on 127.0.0.1:$REVBOUND_PORT (or REVBOUND_PRODUCTION_URL with the
 * bypass header), then polls it and prints status, return value, error and cost as JSON. `--preview` waits for the whole
 * tree and prints each child's return value too. Exits non-zero unless the run completed.
 */
export default async function run(args: string[], ctx: CliCtx): Promise<void> {
  const options = { input: { type: "string" }, preview: { type: "boolean" }, approve: { type: "boolean" }, "max-usd": { type: "string" },
    note: { type: "string" }, prod: { type: "boolean" }, "no-wait": { type: "boolean" } } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (positionals.length !== 1) throw new Error(USAGE);
  if (values.preview && values.approve) throw new Error("--preview and --approve go in two runs: the preview first, then, after a yes, --approve.");
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (values.approve && !(maxUsd! > 0)) throw new Error("--approve needs --max-usd <dollars>, the most the run may spend.");
  if (!values.approve && (maxUsd !== undefined || values.note !== undefined)) throw new Error("--max-usd and --note go with --approve.");
  loadEnv(ctx.dir, true);
  let input: unknown;
  try { input = values.input === undefined ? undefined : JSON.parse(values.input); }
  catch { throw new Error(`--input must be JSON, e.g. --input '{"limit":5}'`); }
  const headers: Record<string, string> = { "content-type": "application/json", "x-revbound-client": "cli" };
  let base = `http://127.0.0.1:${appPort()}${basePath()}`;
  if (values.prod) {
    const url = value("REVBOUND_PRODUCTION_URL"), secret = value("REVBOUND_BYPASS_SECRET");
    if (!url || !secret) throw new Error("--prod needs REVBOUND_PRODUCTION_URL and REVBOUND_BYPASS_SECRET in .env.local (`npx revbound docs deploy`).");
    base = new URL(url.includes("://") ? url : `https://${url}`).origin;
    headers["x-vercel-protection-bypass"] = secret;
  }
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}/api/revbound${path}`, { ...init, headers, redirect: "manual" }).catch((error: Error) => {
      throw new Error(values.prod ? `${base} is unreachable: ${error.message}` : `Nothing answers on ${base}; start \`npm run dev\` first.`);
    });
    if (res.status === 401 || (res.status >= 300 && res.status < 400))
      throw new Error(`Vercel's login answered instead of the app (${res.status}); REVBOUND_BYPASS_SECRET is wrong or outdated.`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} from ${path}: ${json.error ?? res.statusText}`);
    return json;
  };
  const body = { ...(input !== undefined && { input }), ...(values.preview && { preview: true }),
    ...(values.approve && { approve: { maxUsd, ...(values.note && { note: values.note }) } }) };
  const started = await call(`/start/${encodeURIComponent(positionals[0])}`, { method: "POST", body: JSON.stringify(body) });
  if (values["no-wait"]) return console.log(JSON.stringify({ runId: started.runId }, null, 2));
  console.error(`Started run ${started.runId}${values.preview ? " (preview)" : ""}; waiting for it${values.preview ? " and its children" : ""} to finish (Ctrl-C stops waiting, not the run).`);
  for (let misses = 0; ; ) {
    await sleep(1000);
    const state = await call(`/runs/${encodeURIComponent(started.runId)}${values.preview ? "?tree=1" : ""}`).catch((error) => {
      if ((misses += 1) >= 10) throw error; // ten failed polls in a row
    });
    if (state) misses = 0;
    if (!state?.final) continue;
    const r: Row = state.run, cost = state.costUsd ?? r.costUsd;
    const out: Record<string, unknown> = { runId: r.id, status: r.status, returnValue: r.returnValue ?? null, error: r.error ?? null,
      costUsd: cost, ...((state.unmetered ?? r.unmetered) > 0 && { unmeteredCalls: state.unmetered ?? r.unmetered }) };
    if (values.preview) out.children = (state.tree as Row[]).map((c) => ({ runId: c.id, workflow: c.workflow, status: c.status, returnValue: c.returnValue ?? null, error: c.error ?? null }));
    console.log(JSON.stringify(out, null, 2));
    if (values.preview) console.error(`Preview total: ${cost && cost < 0.0001 ? "under $0.0001" : `$${(cost ?? 0).toFixed(4)}`}${out.unmeteredCalls ? ` plus ${out.unmeteredCalls} call(s) on your plan, not metered` : ""}. Show it to the person and ask Yes/No before --approve.`);
    if (r.status !== "completed") process.exitCode = 1;
    return;
  }
}
