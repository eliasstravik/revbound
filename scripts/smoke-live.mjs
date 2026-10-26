#!/usr/bin/env node
/**
 * The live smoke test, run by hand against a real Vercel Pro + Neon deployment of a Revbound project (never in CI):
 *
 *   node <revbound repo>/scripts/smoke-live.mjs --install     # in the project: adds the smoke workflows and webhook, then commit and deploy
 *   node <revbound repo>/scripts/smoke-live.mjs               # in the project, after the deploy: runs the checks
 *
 * It needs, in the project's .env.local or the shell: REVBOUND_PRODUCTION_URL, REVBOUND_BYPASS_SECRET (the automation bypass),
 * CRON_SECRET (the same value as Production's), and for the webhook REVBOUND_SMOKE_HOOK_BYPASS (the smoke sender's own
 * bypass secret, stored in Production as REVBOUND_HOOK_SMOKE_BYPASS) and REVBOUND_SMOKE_SIGNATURE (Production's
 * SMOKE_SIGNATURE). Steps: revbound check --prod; a preview, then --approve on it; one cron tick of a scheduled workflow;
 * the hourly reconcile; ledger rows present; a forced failure reconciled; one signed webhook.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const dir = process.cwd();
const revbound = (args) => spawnSync("npx", ["revbound", ...args], { cwd: dir, encoding: "utf8", env: process.env });
const fail = (message) => { console.error(`smoke: FAILED: ${message}`); process.exit(1); };
const ok = (message) => console.log(`smoke: ok: ${message}`);

if (process.argv.includes("--install")) {
  const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, "workflows", "smoke.ts"), `import { agent } from "#revbound/ai";
import { currentRun } from "#revbound/workflows";

/** Smoke test: one small model call; needs a yes. */
export async function smoke(input: { word: string }) {
  "use workflow";
  const run = await currentRun();
  const r = await agent({ name: "smoke", instructions: "Answer with one word.", prompt: \`Repeat: \${input.word}\`, maxOutputTokens: 16 });
  return { preview: run.preview, answer: r.value, costUsd: r.costUsd };
}

/** Smoke test: a scheduled run with no input. */
export async function smokeCron() {
  "use workflow";
  return (await currentRun()).trigger;
}

/** Smoke test: what the signed webhook starts. */
export async function smokeHooked() {
  "use workflow";
  return (await currentRun()).trigger;
}

/** Smoke test: always fails, so reconcile records the failure. */
export async function smokeFail() {
  "use workflow";
  throw new Error("smoke: a forced failure");
}
`);
  writeFileSync(join(dir, "webhooks", "smoke.ts"), `import { webhook } from "#revbound/workflows";

/** Smoke test: a webhook signed with SMOKE_SIGNATURE that starts smoke-hooked. */
export const smokeHook = webhook<{ id: string }>({
  verify: (req) => Boolean(process.env.SMOKE_SIGNATURE) && req.headers.get("x-smoke-signature") === process.env.SMOKE_SIGNATURE,
  dedupe: (_req, body) => body.id,
  onEvent: async ({ start }) => { await start("smoke-hooked"); },
});
`);
  console.log(`Added workflows/smoke.ts and webhooks/smoke.ts. Register them:

  workflows/index.ts:  import { smoke, smokeCron, smokeFail, smokeHooked } from "./smoke";
    smoke: { run: smoke, approval: { required: true }, budget: { perRunUsd: 1, perMonthUsd: 10 } },
    "smoke-cron": { run: smokeCron, approval: { required: true }, budget: { perRunUsd: 1, perMonthUsd: 10 }, schedule: { approvedUntil: "${until}", note: "smoke test" } },
    "smoke-fail": smokeFail,
    "smoke-hooked": smokeHooked,
  webhooks/index.ts:   import { smokeHook } from "./smoke";   then   smoke: smokeHook,
  vercel.json crons:   { "path": "/api/revbound/cron/smoke-cron", "schedule": "0 5 * * *" }

Then set SMOKE_SIGNATURE and REVBOUND_HOOK_SMOKE_BYPASS in Production, commit, deploy, and run this script without --install.`);
  process.exit(0);
}

if (existsSync(join(dir, ".env.local"))) {
  for (const line of readFileSync(join(dir, ".env.local"), "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*['"]?(.*?)['"]?\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const { REVBOUND_PRODUCTION_URL: url, REVBOUND_BYPASS_SECRET: bypass, CRON_SECRET: cron } = process.env;
if (!url || !bypass || !cron) fail("set REVBOUND_PRODUCTION_URL, REVBOUND_BYPASS_SECRET and CRON_SECRET");
const base = new URL(url.includes("://") ? url : `https://${url}`).origin;
const call = async (path, init = {}) => {
  const res = await fetch(`${base}/api/revbound${path}`, { redirect: "manual", ...init, headers: { "content-type": "application/json", ...init.headers } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const automation = { "x-vercel-protection-bypass": bypass, "x-revbound-client": "cli" };

const check = revbound(["check", "--prod"]);
if (check.status !== 0) fail(`revbound check --prod:\n${check.stdout}${check.stderr}`);
ok("revbound check --prod");

const input = JSON.stringify({ word: `smoke-${Date.now()}` });
const preview = revbound(["run", "smoke", "--prod", "--input", input, "--preview"]);
if (preview.status !== 0) fail(`the preview:\n${preview.stdout}${preview.stderr}`);
const approved = revbound(["run", "smoke", "--prod", "--input", input, "--approve", "--max-usd", "0.5", "--note", "smoke test"]);
if (approved.status !== 0) fail(`--approve:\n${approved.stdout}${approved.stderr}`);
const approvedRun = JSON.parse(approved.stdout.slice(approved.stdout.indexOf("{")));
ok(`preview, then --approve (run ${approvedRun.runId}, $${approvedRun.costUsd})`);

const tick = await call("/cron/smoke-cron", { headers: { authorization: `Bearer ${cron}` } });
if (tick.status !== 200) fail(`the cron tick answered ${tick.status}: ${JSON.stringify(tick.body)}`);
ok(`one cron tick (run ${tick.body.runId})`);

const failed = await call("/start/smoke-fail", { method: "POST", body: "{}", headers: automation });
if (failed.status !== 200) fail(`starting smoke-fail answered ${failed.status}`);
let reconciled;
for (let i = 0; i < 30; i += 1) {
  await sleep(10_000);
  const pass = await call("/ledger/reconcile", { headers: { authorization: `Bearer ${cron}` } });
  if (pass.status !== 200) fail(`the reconcile route answered ${pass.status}: ${JSON.stringify(pass.body)}`);
  const [a, c, f] = await Promise.all([approvedRun.runId, tick.body.runId, failed.body.runId].map((id) => call(`/runs/${id}`, { headers: automation })));
  if ([a, c, f].some((r) => r.status !== 200)) fail("a ledger row is missing");
  if (f.body.run.status === "failed" && c.body.run.status !== "running") { reconciled = { a, c, f }; break; }
}
if (!reconciled) fail("the forced failure was not reconciled within 5 minutes");
ok(`the hourly reconcile route; ledger rows present; the forced failure reconciled (${reconciled.f.body.run.reason})`);

const hookBypass = process.env.REVBOUND_SMOKE_HOOK_BYPASS, signature = process.env.REVBOUND_SMOKE_SIGNATURE;
if (hookBypass && signature) {
  const hook = await call("/hooks/smoke", { method: "POST", body: JSON.stringify({ id: `smoke-${Date.now()}` }),
    headers: { "x-vercel-protection-bypass": hookBypass, "x-smoke-signature": signature } });
  if (hook.status !== 200) fail(`the signed webhook answered ${hook.status}: ${JSON.stringify(hook.body)}`);
  const refused = await call("/hooks/smoke", { method: "POST", body: "{}", headers: { "x-vercel-protection-bypass": bypass } });
  if (refused.status !== 403) fail(`the automation secret on the webhook answered ${refused.status}, not 403`);
  ok(`one signed webhook (run ${hook.body.runId}); the automation secret refused there`);
} else console.log("smoke: skipped the webhook (set REVBOUND_SMOKE_HOOK_BYPASS and REVBOUND_SMOKE_SIGNATURE)");
console.log("smoke: all checks passed.");
