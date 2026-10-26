/**
 * The acceptance suite, against an `npm pack` tarball of this package: a project made by `revbound init`, its build, revbound dev,
 * workflows through the ledger (previews, approvals, limits, fanOut, webhooks), the console, the guards, the fixture
 * plugin, a packed third-party plugin with add/remove/eject/diff, and the bundles.
 *
 * Usage:
 *   npm test                                   # packs a copy of this repo first (needs `npm ci` done here)
 *   GTM_TEST_TARBALL=/abs/revbound-<version>.tgz node --test test/acceptance.test.mjs
 * Optional env: GTM_TEST_TARBALL · GTM_TEST_DIR (parent of the temp work folder) · GTM_TEST_LOGS · GTM_TEST_PORT (first
 * of four consecutive ports; default 4710) · GTM_TEST_KEEP=1 (keep the projects).
 * Needs Linux (`ss`, /proc), tar, openssl and the npm registry. AI steps run on test/fixtures/bin/claude, a stand-in for
 * the signed-in `claude` CLI, so nothing reaches a model provider. Every command runs with an empty environment except
 * PATH, HOME, NEXT_TELEMETRY_DISABLED=1 and what a check sets on purpose.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  MIN, assertOk, cleanEnv, extractCli, httpsStub, killInside, listeningSockets, makeWorkDir, packPackage, poll, portOpen, processTree, REPO,
  request, run, setLogDir, snapshot, diffSnapshots, sql, startProcess, stopAll, tail, waitForHttp,
} from "./helpers.mjs";

const PORT = Number(process.env.GTM_TEST_PORT ?? 4710); // revbound dev
const START_PORT = PORT + 1; // hosted-mode `next start`
const PROBE_PORT = PORT + 2; // HTTPS stand-in for Vercel's login wall
const BOX = "box.tail1234.ts.net";
const FAKE_BIN = path.join(REPO, "test", "fixtures", "bin");
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const NEEDS_YES = "This workflow needs a person's yes. Run a preview, show the person the sample and the cost, and ask Yes/No in chat. Only after a yes, run it again with `--approve --max-usd`.";

const s = { work: "", tarball: "", cli: "", dir: "", dev: null, dbUrl: "" };
const file = (rel, dir = s.dir) => path.join(dir, rel);
const read = (rel, dir = s.dir) => fs.readFileSync(file(rel, dir), "utf8");
const write = (rel, text, dir = s.dir) => { fs.mkdirSync(path.dirname(file(rel, dir)), { recursive: true }); fs.writeFileSync(file(rel, dir), text); };
const exists = (rel, dir = s.dir) => fs.existsSync(file(rel, dir));
/** The environment AI steps get: the stand-in claude first on PATH. */
const withClaude = (env = {}) => ({ PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, ...env });
const revbound = (args, { env = {}, timeout = 10 * MIN, dir = s.dir, input } = {}) =>
  run(file("node_modules/.bin/revbound", dir), args, { cwd: dir, env: cleanEnv(env), timeout, name: `gtm-${args[0]}`, input });
const npm = (args, { env = {}, timeout = 20 * MIN, dir = s.dir } = {}) => run("npm", args, { cwd: dir, env: cleanEnv(env), timeout, name: `npm-${args.at(-1)}` });
const init = (args, cwd = s.work, env = {}) => run("node", [s.cli, "init", ...args], {
  cwd, env: cleanEnv({ GTM_PACKAGE_SPEC: `file:${s.tarball}`, ...env }), timeout: 20 * MIN, name: `gtm-init${args.join("")}`,
});
const get = (pathname, opts) => request(PORT, pathname, opts);
async function json(pathname, opts) {
  const r = await get(pathname, opts);
  assert.equal(r.status, 200, `GET ${pathname} → ${r.status}: ${r.text.slice(0, 500)}`);
  return r.json();
}
/** A refusal: 4xx, and not "no such route" (404) or "wrong method" (405), so a missing route cannot pass as a guard. */
function refused(r, what) {
  assert.ok(r.status >= 400 && r.status < 500 && r.status !== 404 && r.status !== 405, `${what} should be refused, got ${r.status}: ${r.text.slice(0, 300)}`);
}

async function startDev(dir = s.dir, env = {}) {
  await stopDev(); // a failed test may have left one running
  assert.ok(await poll(async () => !(await portOpen(PORT)), { timeout: 30_000 }), `port ${PORT} is still in use`);
  const proc = startProcess(file("node_modules/.bin/revbound", dir), ["dev"], { cwd: dir, env: cleanEnv(withClaude({ GTM_PORT: String(PORT), ...env })), name: "gtm-dev" });
  s.dev = proc;
  await waitForHttp(PORT, "/api/gtm/shell", proc);
  s.dbUrl = `postgres://postgres:postgres@127.0.0.1:${JSON.parse(read(".gtm/db.lock", dir)).port}/postgres?sslmode=disable`;
  return proc;
}
async function stopDev() {
  if (!s.dev) return;
  await s.dev.stop();
  s.dev = null;
  await poll(async () => !(await portOpen(PORT)), { timeout: 30_000 });
}
/** `revbound run …` against the dev server, its printed JSON parsed (null when it printed none). */
async function gtmRun(args, env = {}) {
  const r = await revbound(["run", ...args], { env: withClaude({ GTM_PORT: String(PORT), ...env }), timeout: 5 * MIN });
  const at = r.stdout.indexOf("{");
  let out = null;
  try { out = at >= 0 ? JSON.parse(r.stdout.slice(at)) : null; } catch {}
  return { ...r, out };
}
/** Registers workflows: `imports` lines and `entries` (name → entry source) added to workflows/index.ts. */
function register(imports, entries) {
  const registry = read("workflows/index.ts");
  const body = Object.entries(entries).map(([n, e]) => `  ${JSON.stringify(n)}: ${e},`).join("\n");
  const next = registry.replace(/export const workflows = \{\n?/, (m) => `${m.trimEnd()}\n${body}\n`);
  assert.notEqual(next, registry, `cannot register in workflows/index.ts:\n${registry}`);
  write("workflows/index.ts", `${imports}\n${next}`);
}

/** What a bundle holds that it must not: pg, React, CSS, route handler code (by strings only those modules carry). */
function forbidden(text, { handlers = true } = {}) {
  const marks = { pg: /SCRAM-SHA-256|pg-pool|new Pool\(|pgpass/, react: /react\.production|react-dom|__SECRET_INTERNALS|createElement\(/, css: /\.css["']|font-face|--background:/,
    ...(handlers && { handlers: /No workflow named|The signature does not verify|Drizzle Studio|could not list workflow runs/ }) };
  return Object.entries(marks).filter(([, re]) => re.test(text)).map(([k]) => k);
}

before(async () => {
  s.work = makeWorkDir();
  setLogDir(process.env.GTM_TEST_LOGS ?? path.join(s.work, "logs"));
  s.tarball = await packPackage(s.work);
  s.cli = await extractCli(s.tarball, s.work);
}, { timeout: 15 * MIN });

after(async () => {
  await stopAll();
  if (!s.work) return;
  const strays = killInside(s.work);
  if (strays.length) console.error(`# killed ${strays.length} process(es) still running in ${s.work}:\n# ${strays.join("\n# ")}`);
  if (process.env.GTM_TEST_KEEP === "1") return;
  for (const name of fs.readdirSync(s.work)) if (name !== "logs") fs.rmSync(path.join(s.work, name), { recursive: true, force: true });
});

test("init --company Acme makes ./gtm-acme with the seven defaults; the build runs revbound check first and passes; revbound check passes with no env", { timeout: 40 * MIN }, async () => {
  assertOk(await init(["--company", "Acme"]), "revbound init --company Acme");
  s.dir = path.join(s.work, "gtm-acme");
  const config = read("gtm.config.ts");
  for (const p of ["database()", "ledger({", "workflows({", "ai()", "context()", "connections()", "console()"]) assert.ok(config.includes(p), `gtm.config.ts lists ${p}`);
  assert.match(config, /company: "Acme"/);
  assert.deepEqual(JSON.parse(read("vercel.json")).crons, [{ path: "/api/gtm/ledger/reconcile", schedule: "0 * * * *" }]);
  for (const f of ["gtm/manifest.ts", "gtm/routes.ts", "gtm/views.tsx", "gtm/next.ts", "gtm/database.ts", "gtm/ai.ts", "gtm/slots/ai.ts", "proxy.ts", "app/layout.tsx"]) assert.ok(exists(f), f);
  assert.equal(JSON.parse(read("package.json")).scripts.build, "revbound check --build && revbound migrate && next build");
  assert.equal(JSON.parse(read("package.json")).imports["#gtm/database"], "./gtm/database.ts");
  assert.equal(fs.readlinkSync(file(".claude/skills")), "../.agents/skills");
  const build = assertOk(await npm(["run", "build"]), "npm run build");
  assert.ok(build.output.indexOf("revbound check --build") < build.output.indexOf("Next.js"), "revbound check runs before next build");
  assertOk(await revbound(["check"]), "revbound check");
});

test("bundles: the workflow and proxy bundles hold no pg, React or CSS, and the proxy no route handler code", { timeout: 10 * MIN }, async (t) => {
  if (!s.dir) return t.skip("no project");
  const flow = read("app/.well-known/workflow/v1/flow/route.js");
  assert.deepEqual(forbidden(flow.slice(flow.indexOf("const workflowCode"))), [], "the workflow bundle");
  const loaded = [...read(".next/server/middleware.js").matchAll(/R\.c\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(loaded.length > 0, "the proxy bundle's chunks");
  for (const chunk of loaded) assert.deepEqual(forbidden(read(path.join(".next", chunk))), [], chunk);
});

test("revbound dev: 127.0.0.1 only; every console view and its API answers; build, migrate and check alongside", { timeout: 30 * MIN }, async (t) => {
  if (!s.dir) return t.skip("no project");
  await startDev();
  const sockets = listeningSockets(processTree(s.dev.pid, s.dir));
  assert.deepEqual(sockets.filter((x) => x.address !== "127.0.0.1" && x.address !== "::ffff:127.0.0.1"), [], JSON.stringify(sockets));
  for (const p of ["/", "/context", "/workflows", "/runs", "/data", "/connections", "/icon.svg"]) assert.equal((await get(p)).status, 200, p);
  assert.equal((await get("/no-such-view")).status, 404);
  assert.deepEqual(await json("/api/gtm/shell"), { company: "Acme", environment: "local", deployment: null });
  assert.equal((await json("/api/gtm/context")).groups[0].files[0].path, "context/company.md");
  assert.deepEqual((await json("/api/gtm/workflows")).workflows, []);
  assert.deepEqual((await json("/api/gtm/ledger/runs")).data, []);
  assert.ok((await json("/api/gtm/data")).tables.some((x) => x.name === "gtm_ledger.runs"));
  assert.equal((await json("/api/gtm/connections/missing")).count, 0);
  assert.equal((await get("/api/gtm/nothing")).status, 404, "an undeclared /api path");
  assertOk(await revbound(["migrate"]), "revbound migrate while dev runs");
  assertOk(await revbound(["check"]), "revbound check while dev runs");
});

test("a workflow that writes a row: db:generate, revbound migrate, revbound run; Runs from the ledger, Data, CSV, the inspector", { timeout: 30 * MIN }, async (t) => {
  if (!s.dev) return t.skip("no dev server");
  fs.appendFileSync(file("db/schema.ts"), `
import * as acceptancePg from "drizzle-orm/pg-core";

export const records = acceptancePg.pgTable("records", {
  id: acceptancePg.serial("id").primaryKey(),
  name: acceptancePg.text("name").notNull(),
});
`);
  write("workflows/record.ts", `import { db } from "#gtm/database";
import { records } from "../db/schema";

async function insertRecord(name: string) {
  "use step";
  const [row] = await db().insert(records).values({ name }).returning();
  return { id: row.id, name: row.name };
}

export async function record(input: { name: string }) {
  "use workflow";
  return { inserted: await insertRecord(input.name) };
}
`);
  register(`import { record } from "./record";`, { record: `{ run: record, description: "Writes one row.", tables: ["records"], connections: ["ACME_API_KEY"] }` });
  assertOk(await npm(["run", "db:generate"]), "npm run db:generate");
  assertOk(await revbound(["migrate"]), "revbound migrate");
  const r = await gtmRun(["record", "--input", JSON.stringify({ name: "=HYPERLINK(1)" })]);
  assertOk(r, "revbound run record");
  assert.equal(r.out.status, "completed");
  assert.deepEqual(r.out.returnValue.inserted.name, "=HYPERLINK(1)");
  const runs = (await json("/api/gtm/ledger/runs")).data;
  const row = runs.find((x) => x.id === r.out.runId);
  assert.ok(row && row.trigger === "cli" && row.status === "completed" && row.sdkRunId, JSON.stringify(runs));
  assert.deepEqual((await json("/api/gtm/data/records")).rows.map((x) => x[1]), ["=HYPERLINK(1)"]);
  assert.match((await get("/api/gtm/data/records/csv?columns=name")).text, /^name\n'=HYPERLINK\(1\)\n/);
  assert.equal((await get("/api/gtm/inspector")).status, 200, "the run inspector, loopback");
  refused(await get("/api/gtm/inspector", { headers: { "x-forwarded-host": BOX } }), "the inspector through a forwarded host");
  const missing = (await json("/api/gtm/connections")).connections.find((c) => c.name === "ACME_API_KEY");
  assert.deepEqual([missing.state, missing.usedBy.workflows], ["missing", ["record"]]);
});

test("Runs pages: rows that share one start time are each on some page", { timeout: 10 * MIN }, async (t) => {
  if (!s.dir) return t.skip("no project");
  if (!s.dev) await startDev();
  await sql(s.dir, s.dbUrl, `insert into gtm_ledger.runs (id, workflow, trigger, root_run_id, status, started_at)
    select g.id, 'pager', 'cli', g.id, 'completed', '2020-01-01T00:00:00.123456Z' from (select gen_random_uuid() as id from generate_series(1, 55)) g`);
  const seen = new Set();
  let page = await json("/api/gtm/ledger/runs?workflow=pager"), pages = 1;
  for (const r of page.data) seen.add(r.id);
  while (page.next && pages < 5) {
    page = await json(`/api/gtm/ledger/runs?workflow=pager&before=${encodeURIComponent(page.next)}`);
    for (const r of page.data) seen.add(r.id);
    pages += 1;
  }
  assert.deepEqual([seen.size, pages, page.hasMore], [55, 2, false]);
});

test("the ledger end to end: 403 without a yes, a preview of the tree with each child's value, --approve on it, limits, refusals", { timeout: 30 * MIN }, async (t) => {
  if (!s.dev) return t.skip("no dev server");
  write("workflows/score.ts", `import { z } from "zod";
import { agent } from "#gtm/ai";
import { action } from "#gtm/ledger";
import { currentRun, fanOut } from "#gtm/workflows";

/** Scores one company; a child of score-list. */
export async function scoreOne(company: string) {
  "use workflow";
  const r = await agent({ name: "score", instructions: "Score the company.", prompt: company, schema: z.object({ score: z.number() }) });
  return { company, score: r.value.score };
}

/** Scores a list: one child per company, then a summary. Preview-aware: a preview scores the first two. */
export async function scoreList(input: { companies: string[] }) {
  "use workflow";
  const run = await currentRun();
  const ids = await fanOut(input.companies, "score-one", { batchSize: 2 });
  const summary = await agent({ name: "summarize", instructions: "Summarize.", prompt: \`\${ids.length} companies\`, schema: z.object({ summary: z.string() }) });
  return { children: ids.length, preview: run.preview, summary: summary.value.summary };
}

/** Calls the model more often than a preview allows. */
export async function chatty() {
  "use workflow";
  for (let i = 0; i < 4; i += 1) await agent({ name: \`call\${i}\`, instructions: "Say hi.", prompt: "hi" });
  return "done";
}

/** A plain parent whose child needs a yes. */
export async function plainParent() {
  "use workflow";
  return await fanOut([1], "needs-yes");
}
export async function needsYes() {
  "use workflow";
  return await agent({ name: "x", instructions: "x", prompt: "x" });
}

/** Two fanOut calls in one run: each starts its own children. */
export async function twoFans() {
  "use workflow";
  return { a: await fanOut(["first"], "echo-a"), b: await fanOut(["second"], "echo-b") };
}
export async function echoA(x: string) {
  "use workflow";
  return { a: x };
}
export async function echoB(x: string) {
  "use workflow";
  return { b: x };
}

/** Two action() calls with one key at once, in one step: only one may run. */
async function twice() {
  "use step";
  let calls = 0;
  const one = () => action({ kind: "paid_api", target: "test", idempotencyKey: "twin-key", estimateUsd: 0.6,
    run: async () => { calls += 1; await new Promise((r) => setTimeout(r, 200)); return { value: calls, costUsd: 0.6 }; } });
  const [a, b] = await Promise.all([one(), one()]);
  return { statuses: [a.status, b.status].sort(), calls };
}
export async function twinActions() {
  "use workflow";
  return await twice();
}
`);
  register(`import { chatty, echoA, echoB, needsYes, plainParent, scoreList, scoreOne, twinActions, twoFans } from "./score";`, {
    "twin-actions": "{ run: twinActions, budget: { perRunUsd: 1, perMonthUsd: 5 } }",
    "two-fans": "twoFans",
    "echo-a": "echoA",
    "echo-b": "echoB",
    "score-list": "{ run: scoreList, approval: { required: true, previewItems: 2 } }",
    "score-one": "scoreOne",
    chatty: "{ run: chatty, approval: { required: true, previewCalls: 2 } }",
    "plain-parent": "plainParent",
    "needs-yes": "{ run: needsYes, approval: { required: true } }",
  });
  assertOk(await revbound(["check", "--build"]), "revbound check --build");
  const input = JSON.stringify({ companies: ["acme.example", "globex.example", "initech.example"] });
  const no = await gtmRun(["score-list", "--input", input]);
  assert.notEqual(no.code, 0);
  assert.ok(no.output.includes(`403 from /start/score-list: ${NEEDS_YES}`), tail(no.output));
  const early = await gtmRun(["score-list", "--input", input, "--approve", "--max-usd", "5"]);
  assert.match(early.output, /No completed preview of this exact input/);

  const preview = await gtmRun(["score-list", "--input", input, "--preview"]);
  assertOk(preview, "the preview");
  assert.deepEqual([preview.out.status, preview.out.returnValue.children, preview.out.returnValue.preview], ["completed", 2, true]);
  assert.deepEqual(preview.out.children.map((c) => [c.workflow, c.status, c.returnValue.company, c.returnValue.score]),
    [["score-one", "completed", "acme.example", 1], ["score-one", "completed", "globex.example", 1]], "fanOut truncated to previewItems, each child's value");
  assert.equal(preview.out.unmeteredCalls, 3, "the local CLI backend: plan usage, counted");
  assert.match(preview.stderr, /Preview total: \$0\.0000 plus 3 call\(s\) on your plan, not metered/);

  const tiny = await gtmRun(["score-list", "--input", input, "--approve", "--max-usd", "0.005"]);
  assert.notEqual(tiny.code, 0);
  assert.match(tiny.output, /An approval is in whole cents, \$0\.01 or more, not \$0\.005/);
  const yes = await gtmRun(["score-list", "--input", JSON.stringify({ companies: ["acme.example", "globex.example", "initech.example"] }), "--approve", "--max-usd", "5", "--note", "Yes in chat"]);
  assertOk(yes, "the approved run");
  assert.equal(yes.out.returnValue.children, 3);
  const runs = (await json("/api/gtm/ledger/runs?workflow=score-list")).data;
  const approved = runs.find((x) => x.id === yes.out.runId), shown = runs.find((x) => x.id === preview.out.runId);
  assert.deepEqual([approved.approvedMaxUsd, approved.approvalNote, shown.preview], [5, "Yes in chat", true]);
  const tree = await sql(s.dir, s.dbUrl, "select count(*)::int as n from gtm_ledger.runs where root_run_id = $1 and trigger = 'child'", [yes.out.runId]);
  assert.equal(tree[0].n, 3);

  const limit = await gtmRun(["chatty", "--preview"]);
  assert.equal(limit.out?.status, "failed");
  assert.match(limit.out.error, /A preview makes at most 2 metered or plan calls\. Size previews with currentRun\(\)\.preview\./);
  const blocked = await sql(s.dir, s.dbUrl, "select count(*)::int as n from gtm_ledger.actions where outcome = 'blocked' and run_id = $1", [limit.out.runId]);
  assert.equal(blocked[0].n, 1, "the refused call is a blocked row");

  const fans = await gtmRun(["two-fans", "--preview"]);
  assertOk(fans, "two fanOut calls");
  assert.notDeepEqual(fans.out.returnValue.a, fans.out.returnValue.b, "each fanOut started its own child");
  assert.deepEqual(fans.out.children.map((c) => [c.workflow, c.status, c.returnValue]).sort(),
    [["echo-a", "completed", { a: "first" }], ["echo-b", "completed", { b: "second" }]]);

  const twins = await gtmRun(["twin-actions"]);
  assertOk(twins, "two action() calls with one key");
  assert.deepEqual(twins.out.returnValue, { statuses: ["done", "refused"], calls: 1 }, "one key runs once at a time");
  assert.equal(twins.out.costUsd, 0.6);

  const parent = await gtmRun(["plain-parent"]);
  assert.equal(parent.out?.status, "failed");
  assert.match(parent.out.error, /child 0 of needs-yes was refused: This workflow needs a person's yes/);
});

test("webhooks on the Local World: bad signatures are refused, concurrent repeats run onEvent once, a throwing onEvent releases its claim", { timeout: 20 * MIN }, async (t) => {
  if (!s.dev) return t.skip("no dev server");
  write("webhooks/index.ts", `import { appendFileSync } from "node:fs";
import { webhook, type Webhooks } from "#gtm/workflows";

export const webhooks = {
  test: webhook<{ id: string; fail?: boolean }>({
    verify: (req) => req.headers.get("x-signature") === "good",
    dedupe: (_req, body) => body.id,
    async onEvent({ body }) {
      await new Promise((r) => setTimeout(r, 300));
      if (body.fail) throw new Error("onEvent failed");
      appendFileSync(".gtm/hook-hits.log", body.id + "\\n");
    },
  }),
} satisfies Webhooks;
`);
  await poll(async () => (await get("/api/gtm/hooks/test", { method: "POST", body: { id: "probe" }, headers: { "x-signature": "bad" } })).status === 401, { timeout: 60_000 });
  const send = (body) => get("/api/gtm/hooks/test", { method: "POST", body, headers: { "x-signature": "good" } });
  const all = await Promise.all(Array.from({ length: 5 }, () => send({ id: "evt_1" })));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.deepEqual(read(".gtm/hook-hits.log").trim().split("\n"), ["evt_1"], "onEvent ran once");
  assert.equal((await send({ id: "evt_2", fail: true })).status, 500);
  const rows = await sql(s.dir, s.dbUrl, "select count(*)::int as n from gtm_workflows.webhook_events where dedupe_key = 'evt_2'");
  assert.equal(rows[0].n, 0, "the claim was released, so the sender retries");
  assert.equal((await get("/api/gtm/hooks/nope", { method: "POST", body: {}, headers: { "x-signature": "good" } })).status, 404);
});

test("connections: set reads a hidden value from stdin into .env.local (0600), list shows it, argv values and owned names are refused", { timeout: 10 * MIN }, async (t) => {
  if (!s.dir) return t.skip("no project");
  write(".env.example", `${read(".env.example")}# Acme's API\nACME_API_KEY=\n`);
  const set = await revbound(["connections", "set", "ACME_API_KEY"], { input: "sk-test-$value\"quoted\n" });
  assertOk(set, "revbound connections set");
  assert.ok(!set.output.includes("sk-test"), "the value is never printed");
  assert.equal(fs.statSync(file(".env.local")).mode & 0o777, 0o600);
  assert.match(read(".env.local"), /^ACME_API_KEY='sk-test-\\\$value"quoted'$/m);
  assert.match((await revbound(["connections", "list"])).stdout, /^set\s+ACME_API_KEY\s+\(Acme's API\)$/m);
  assert.notEqual((await revbound(["connections", "set", "ACME_API_KEY", "inline-value"])).code, 0, "a value in argv");
  assert.match((await revbound(["connections", "set", "DATABASE_URL"], { input: "x" })).output, /set by Revbound, Vercel or an integration/);
  if (s.dev) {
    await poll(async () => (await json("/api/gtm/connections")).connections.find((c) => c.name === "ACME_API_KEY")?.state === "set", { timeout: 60_000 });
  }
  assertOk(await revbound(["connections", "delete", "ACME_API_KEY"]), "revbound connections delete");
  assert.doesNotMatch(read(".env.local"), /ACME_API_KEY/);
});

test("guards: cross-site starts, foreign hosts, cron without CRON_SECRET; GTM_ALLOWED_HOSTS reads but never starts", { timeout: 15 * MIN }, async (t) => {
  if (!s.dev) return t.skip("no dev server");
  refused(await get("/api/gtm/start/record", { method: "POST", body: {}, headers: { origin: "http://evil.test" } }), "a foreign Origin");
  refused(await get("/api/gtm/start/record", { method: "POST", body: {}, headers: { "sec-fetch-site": "cross-site" } }), "cross-site");
  refused(await get("/api/gtm/shell", { host: "evil.test" }), "Host: evil.test");
  refused(await get("/", { host: "evil.test" }), "a page on Host: evil.test");
  refused(await get("/api/gtm/cron/record"), "cron with CRON_SECRET unset");
  await stopDev();
  await startDev(s.dir, { GTM_ALLOWED_HOSTS: BOX, CRON_SECRET: "cron-test-secret" });
  const pass = await get("/api/gtm/ledger/reconcile", { headers: { authorization: "Bearer cron-test-secret" } });
  assert.equal(pass.status, 200, `the hourly reconcile route: ${pass.text}`);
  assert.ok("ran" in pass.json());
  refused(await get("/api/gtm/ledger/reconcile", { headers: { authorization: "Bearer wrong" } }), "reconcile with a wrong CRON_SECRET");
  const tick = await get("/api/gtm/cron/record", { headers: { authorization: "Bearer cron-test-secret" } });
  assert.equal(tick.status, 200, `a cron start of a plain workflow: ${tick.text}`);
  refused(await get("/api/gtm/cron/score-list", { headers: { authorization: "Bearer cron-test-secret" } }), "a cron start of an approval-required workflow with no schedule approval");
  assert.equal((await get("/api/gtm/shell", { host: BOX })).status, 200);
  assert.equal((await get("/data", { host: BOX })).status, 200);
  refused(await get("/api/gtm/start/record", { method: "POST", body: {}, host: BOX }), "start on an allowed host");
  refused(await get("/api/gtm/inspector", { host: BOX }), "the inspector on an allowed host");
  refused(await get("/api/gtm/database/open", { method: "POST", body: {}, host: BOX }), "Open database on an allowed host");
});

test("hosted mode: pages and session routes refuse every bypass credential; automation routes take only the automation secret", { timeout: 30 * MIN }, async (t) => {
  if (!s.dir || !s.dbUrl) return t.skip("no project");
  assertOk(await npm(["run", "build"]), "npm run build");
  const stub = await httpsStub(s.work, PROBE_PORT, (_req, res) => res.writeHead(401, { "content-type": "text/plain" }).end("Authentication Required"));
  const host = `127.0.0.1:${PROBE_PORT}`;
  const next = startProcess(file("node_modules/.bin/next"), ["start", "-H", "127.0.0.1", "-p", String(START_PORT)], {
    cwd: s.dir, name: "next-start-hosted",
    env: cleanEnv({ VERCEL_ENV: "preview", VERCEL_DEPLOYMENT_ID: "dpl_test", VERCEL_AUTOMATION_BYPASS_SECRET: "automation-secret", GTM_HOOK_TEST_BYPASS: "sender-secret",
      DATABASE_URL: s.dbUrl, NODE_EXTRA_CA_CERTS: stub.caFile }),
  });
  try {
    await waitForHttp(START_PORT, "/_gtm/probe.txt", next);
    const at = (p, headers = {}, method = "GET") => request(START_PORT, p, { host, headers, method, ...(method === "POST" && { body: {} }) });
    assert.equal((await at("/api/gtm/shell")).json().environment, "preview");
    assert.equal((await at("/data")).status, 200);
    assert.equal((await at("/api/gtm/inspector")).status, 404, "local routes are not hosted");
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "HS256" })}.${b64({ aud: host, bypass: "s", sub: "protection-bypass-automation" })}.sig`;
    const carriers = [
      ["the automation secret", (p) => at(p, { "x-vercel-protection-bypass": "automation-secret" })],
      ["a sender's secret", (p) => at(p, { "x-vercel-protection-bypass": "sender-secret" })],
      ["a query parameter", (p) => at(`${p}${p.includes("?") ? "&" : "?"}x-vercel-protection-bypass=sender-secret`)],
      ["a bypass cookie", (p) => at(p, { cookie: `_vercel_jwt=${jwt}` })],
    ];
    for (const [how, send] of carriers) for (const p of ["/", "/data", "/runs", "/api/gtm/shell", "/api/gtm/data", "/api/gtm/data/records/csv", "/api/gtm/ledger/runs",
      "/api/gtm/connections", "/api/gtm/context/file?path=context/company.md", "/api/gtm/workflows"]) refused(await send(p), `${how} on ${p}`);
    refused(await at("/api/gtm/runs/00000000-0000-0000-0000-000000000000", { "x-vercel-protection-bypass": "sender-secret" }), "a sender's secret on an automation route");
    refused(await at("/api/gtm/hooks/test", { "x-vercel-protection-bypass": "automation-secret" }, "POST"), "the automation secret on a webhook");
    assert.equal((await at("/api/gtm/runs/00000000-0000-0000-0000-000000000000", { "x-vercel-protection-bypass": "automation-secret" })).status, 404, "the automation secret reaches runs/:id");
  } finally {
    await next.stop();
    await stub.close();
  }
});

test("migrations: hosted production refuses an unacknowledged destructive migration, stamps the database, which local commands then refuse", { timeout: 20 * MIN }, async (t) => {
  if (!s.dev) return t.skip("no dev server");
  write("db/schema.ts", read("db/schema.ts").replace(/export const records[\s\S]*?\n\}\);\n/, ""));
  assertOk(await npm(["run", "db:generate"]), "db:generate (drop records)");
  const migration = fs.readdirSync(file("db/migrations")).filter((f) => f.endsWith(".sql")).sort().at(-1);
  assert.match(read(`db/migrations/${migration}`), /DROP TABLE "records"/);
  const prod = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test", DATABASE_URL: s.dbUrl };
  const refusedRun = await revbound(["migrate"], { env: prod });
  assert.notEqual(refusedRun.code, 0);
  assert.match(refusedRun.output, new RegExp(`company:${migration.slice(0, 4)} may lose data`));
  write("gtm.config.ts", read("gtm.config.ts").replace("// acknowledge: { customLedger: true, destructive: [\"company:0012\"] },  // only when needed (`npx revbound docs ledger`)",
    `acknowledge: { destructive: ["company:${migration.slice(0, 4)}"] },`));
  assertOk(await revbound(["sync"]), "revbound sync");
  assertOk(await revbound(["migrate"], { env: prod }), "revbound migrate (acknowledged)");
  const local = await revbound(["migrate"]);
  assert.notEqual(local.code, 0);
  assert.match(local.output, /production's database/);
  await sql(s.dir, s.dbUrl, "delete from gtm.meta where key = 'production'");
});

test("revbound init again changes nothing but restores missing wiring; sync rewrites a deleted shim", { timeout: 10 * MIN }, async (t) => {
  if (!s.dir) return t.skip("no project");
  await stopDev();
  const before = snapshot(s.dir);
  assertOk(await init([], s.dir), "revbound init (re-run)");
  assert.deepEqual(diffSnapshots(before, snapshot(s.dir)), { added: [], removed: [], changed: [] });
  fs.rmSync(file("proxy.ts"));
  fs.rmSync(file("public/_gtm/probe.txt"));
  assertOk(await init([], s.dir), "revbound init (repair)");
  assert.ok(exists("proxy.ts") && exists("public/_gtm/probe.txt"));
  assert.equal(diffSnapshots(before, snapshot(s.dir)).changed.length, 0);
});

test("init picks the local AI backend: claude under Claude Code, codex under Codex, else what is on PATH (a Cursor session)", { timeout: 10 * MIN }, async () => {
  const empty = fs.mkdtempSync(path.join(s.work, "bin-")), dir = (n) => path.join(s.work, `gtm-${n}`);
  const env = (extra) => cleanEnv({ GTM_PACKAGE_SPEC: `file:${s.tarball}`, ...extra });
  const go = (name, extra) => run("node", [s.cli, "init", "--company", name, "--no-install"], { cwd: s.work, env: env(extra), name: `init-${name}` });
  const node = path.dirname(process.execPath);
  assertOk(await go("cursor-claude", { PATH: `${FAKE_BIN}${path.delimiter}${node}`, CURSOR_TRACE_ID: "x" }));
  assert.equal(read(".env.local", dir("cursor-claude")), "GTM_AGENT_BACKEND=claude\n");
  const none = await go("cursor-none", { PATH: `${empty}${path.delimiter}${node}`, CURSOR_TRACE_ID: "x" });
  assertOk(none);
  assert.ok(!exists(".env.local", dir("cursor-none")));
  assert.match(none.output, /AI steps need a provider key or AI Gateway here/);
  assertOk(await go("codex", { PATH: `${empty}${path.delimiter}${node}`, CODEX_THREAD_ID: "t" }));
  assert.equal(read(".env.local", dir("codex")), "GTM_AGENT_BACKEND=codex\n");
});

test("plugins: the fixture plugin adds a table, view, nav item, tab, route, CLI command, docs, AGENTS.md line, skill, check and runtime export", { timeout: 40 * MIN }, async (t) => {
  assertOk(await init(["--company", "Plugins", "--example"]), "revbound init --example");
  const dir = path.join(s.work, "gtm-plugins");
  fs.cpSync(path.join(REPO, "test", "fixtures", "plugin-fixture"), file("plugins/fixture", dir), { recursive: true });
  write("gtm.config.ts", read("gtm.config.ts", dir).replace('import { console } from "revbound/console";', (m) => `${m}\nimport { fixture } from "./plugins/fixture";`)
    .replace("    console(),\n", "    console(),\n    fixture(),\n"), dir);
  write("workflows/greet.ts", `import { greet } from "#gtm/fixture";\n\nexport async function greeting() {\n  "use workflow";\n  return greet("Acme");\n}\n`, dir);
  write("workflows/index.ts", read("workflows/index.ts", dir).replace('import { exampleImport } from "./example-import";', 'import { exampleImport } from "./example-import";\nimport { greeting } from "./greet";')
    .replace("export const workflows = {", "export const workflows = {\n  greeting,"), dir);
  assertOk(await revbound(["sync"], { dir }), "revbound sync");
  const check = assertOk(await revbound(["check"], { dir }), "revbound check");
  assert.match(check.output, /Fixture: its check ran\./);
  assert.match(read("AGENTS.md", dir), /- Fixture plugin: its line in the managed block\./);
  assert.match(read(".agents/skills/fixture-hello/SKILL.md", dir), /name: fixture-hello/);
  assert.match((await revbound(["fixture", "a", "b"], { dir })).stdout, /fixture says hello \(fixture, a b\)/);
  assert.match((await revbound(["docs", "fixture"], { dir })).stdout, /The fixture plugin's docs topic/);
  assert.match((await revbound(["docs"], { dir })).stdout, /npx revbound docs fixture/);
  const manifest = read("gtm/manifest.ts", dir);
  for (const needle of ['"key": "fixture:fixture/hello"', '"path": "fixture"', '"id": "fixture"', '"name": "FIXTURE_API_KEY"', '"schema": "gtm_fixture"']) assert.ok(manifest.includes(needle), needle);
  s.dir = dir;
  await startDev(dir);
  assert.equal((await get("/fixture")).status, 200);
  assert.deepEqual(await json("/api/gtm/fixture/hello"), { hello: "fixture", notes: 1, plugin: "fixture" });
  assert.ok((await json("/api/gtm/data")).tables.some((x) => x.name === "gtm_fixture.notes" && x.label === "Fixture notes"));
  assert.equal((await json("/api/gtm/connections/missing")).count, 1, "the fixture's FIXTURE_API_KEY");
  const r = await gtmRun(["greeting"]);
  assert.equal(r.out?.returnValue, "hello Acme from fixture");
  const example = await gtmRun(["example-import"]);
  assert.equal(example.out?.returnValue.saved, 3);
  await stopDev();
  assertOk(await npm(["run", "build"], { dir }), "npm run build with the fixture");
});

test("a packed plugin: add, swap the database, remove; eject ai and ledger into plugins/ and diff them", { timeout: 40 * MIN }, async (t) => {
  if (!s.dir.endsWith("gtm-plugins")) return t.skip("no plugins project");
  const dir = s.dir;
  const pack = assertOk(await run("npm", ["pack", "--pack-destination", s.work], { cwd: path.join(REPO, "test", "fixtures", "gtm-plugin-fixture"), name: "pack-fixture" }));
  const tgz = path.join(s.work, pack.stdout.trim().split("\n").at(-1));
  const added = assertOk(await revbound(["add", tgz], { dir }), "revbound add");
  assert.match(added.stdout, /import \{ packaged \} from "gtm-plugin-fixture";/);
  assert.equal(JSON.parse(read("package.json", dir)).dependencies["gtm-plugin-fixture"], `file:${path.relative(dir, tgz)}`.replace(/^file:(?!\.)/, "file:"));
  const config = read("gtm.config.ts", dir);
  write("gtm.config.ts", config.replace("import { fixture }", 'import { packaged, swappedDatabase } from "gtm-plugin-fixture";\nimport { fixture }')
    .replace("    database(),\n", "    swappedDatabase(),\n").replace("    fixture(),\n", "    fixture(),\n    packaged(),\n"), dir);
  assertOk(await revbound(["sync"], { dir }), "revbound sync");
  assertOk(await revbound(["check", "--build"], { dir }), "revbound check with the swapped database");
  assert.match(read("gtm/slots/ledger.ts", dir), /import provide\d from "gtm-plugin-fixture\/database";/);
  write("types-test.ts", `import type { Ctx, DatabaseSlotV1 } from "revbound";\nimport swapped from "gtm-plugin-fixture/database";\nexport const slot: (ctx: Ctx) => DatabaseSlotV1 = swapped;\n`, dir);
  assertOk(await run(file("node_modules/.bin/tsc", dir), ["--noEmit", "-p", "."], { cwd: dir, name: "tsc-types" }), "the swapped provider passes DatabaseSlotV1");
  fs.rmSync(file("types-test.ts", dir));
  const removed = assertOk(await revbound(["remove", "packaged"], { dir }), "revbound remove");
  assert.match(removed.stdout, /gtm\.config\.ts:\d+ {2}packaged\(\),/);

  assertOk(await revbound(["eject", "ai"], { dir }), "revbound eject ai");
  assert.match(read("gtm.config.ts", dir), /import \{ ai \} from "\.\/plugins\/ai";/);
  assert.match(read("gtm/ai.ts", dir), /from "\.\.\/plugins\/ai\/runtime"/);
  assert.match(read("plugins/ai/index.ts", dir), /const P = "\.\/plugins\/ai";/);
  assert.ok(exists("plugins/ai/.gtm-eject/src/index.ts", dir) && exists("plugins/ai/.gtm-eject/version", dir));
  assertOk(await revbound(["check", "--build"], { dir }), "revbound check after ejecting ai");
  assert.match((await revbound(["diff", "ai"], { dir })).stdout, new RegExp(`No upstream changes to ai between ${VERSION} and ${VERSION}`));
  assertOk(await revbound(["eject", "ledger"], { dir }), "revbound eject ledger");
  const guard = await revbound(["check", "--build"], { dir });
  assert.notEqual(guard.code, 0);
  assert.match(guard.output, /The ledger slot is not the package's own ledger\(\)/);
  write("gtm.config.ts", read("gtm.config.ts", dir).replace("  plugins: [", "  acknowledge: { customLedger: true },\n  plugins: ["), dir);
  assertOk(await revbound(["sync"], { dir }), "revbound sync");
  assertOk(await revbound(["check", "--build"], { dir }), "revbound check with the acknowledged ledger");
  write("workflows/ask.ts", `import { agent } from "#gtm/ai";\n\nexport async function ask() {\n  "use workflow";\n  return (await agent({ name: "ask", instructions: "Answer.", prompt: "ejected" })).value;\n}\n`, dir);
  write("workflows/index.ts", read("workflows/index.ts", dir).replace('import { greeting } from "./greet";', 'import { greeting } from "./greet";\nimport { ask } from "./ask";')
    .replace("export const workflows = {", "export const workflows = {\n  ask,"), dir);
  await startDev(dir);
  const r = await gtmRun(["ask"]);
  assert.equal(r.out?.returnValue, "echo:ejected", tail(r.output));
  const rows = await sql(dir, s.dbUrl, "select plugin, kind from gtm_ledger.actions where run_id = $1", [r.out.runId]);
  assert.deepEqual(rows, [{ plugin: "ai", kind: "model_call" }], "the ejected ai spends through the one ejected ledger");
  await stopDev();
  assertOk(await npm(["run", "build"], { dir }), "npm run build with ejected ai and ledger");
});

test("the docs recipes install, migrate, build and run", { timeout: 40 * MIN }, async (t) => {
  if (!s.dir.endsWith("gtm-plugins")) return t.skip("no plugins project");
  const dir = s.dir, recipes = path.join(REPO, "docs", "recipes");
  for (const name of ["import-list", "weekly-new-companies", "enrich-companies"]) {
    fs.cpSync(path.join(recipes, name, "workflows"), file("workflows", dir), { recursive: true });
    fs.appendFileSync(file("db/schema.ts", dir), `\n${read(path.join(name, "schema.ts"), recipes)}`);
  }
  write("workflows/index.ts", `import { importList } from "./import-list";
import { weeklyNewCompaniesCount } from "./weekly-new-companies";
import { enrichCompanies } from "./enrich-companies";
${read("workflows/index.ts", dir)}`.replace("export const workflows = {", `export const workflows = {
  "import-list": importList,
  "weekly-new-companies": weeklyNewCompaniesCount,
  "enrich-companies": { run: enrichCompanies, approval: { required: true }, budget: { perRunUsd: 5, perMonthUsd: 50 } },`), dir);
  assertOk(await npm(["run", "db:generate"], { dir }), "db:generate");
  assertOk(await revbound(["check", "--build"], { dir }), "revbound check");
  await startDev(dir);
  const imported = await gtmRun(["import-list", "--input", JSON.stringify({ companies: [{ name: "Acme", domain: "acme.example" }] })]);
  assert.equal(imported.out?.status, "completed", tail(imported.output));
  assert.equal((await gtmRun(["weekly-new-companies"])).out?.status, "completed");
  const preview = await gtmRun(["enrich-companies", "--preview"]);
  assert.equal(preview.out?.status, "completed", tail(preview.output));
  assert.equal(preview.out.returnValue.enriched, 1);
  await stopDev();
  assertOk(await npm(["run", "build"], { dir }), "npm run build with the recipes");
});

test("mdm: revbound add mdm in a fresh project; two workflows with overlapping people and companies make one record each, and the second skips the first's enrichment", { timeout: 40 * MIN }, async () => {
  assertOk(await init(["--company", "Mdm"]), "revbound init --company Mdm");
  const dir = path.join(s.work, "gtm-mdm");
  s.dir = dir;
  const added = assertOk(await revbound(["add", "mdm"], { dir }), "revbound add mdm");
  const [, importLine] = added.stdout.match(/^ {2}(import \{ mdm \} from "revbound\/mdm";)$/m) ?? [];
  assert.ok(importLine && /^ {2}mdm\(\), {3}\/\/ in plugins: \[\.\.\.\]$/m.test(added.stdout), added.stdout);
  assert.ok(!JSON.parse(read("package.json", dir)).dependencies.mdm, "nothing installed");
  write("gtm.config.ts", read("gtm.config.ts", dir).replace('import { console } from "revbound/console";', (m) => `${m}\n${importLine}`)
    .replace("    console(),\n", "    console(),\n    mdm(),\n"), dir);
  assert.match((await revbound(["add", "mdm"], { dir })).stdout, /mdm is already in gtm\.config\.ts/);
  assertOk(await revbound(["sync"], { dir }), "revbound sync");
  assert.match((await revbound(["docs", "mdm"], { dir })).stdout, /^# MDM: people, companies and signals/);

  write("workflows/leads.ts", `import { stale, upsertCompany, upsertPerson, upsertSignal } from "#gtm/mdm";

type Lead = { email?: string; linkedin?: string; name: string; domain: string };

/** The paid lookup each workflow would make: it logs every call, so a skipped one shows. */
async function lookUp(domain: string) {
  "use step";
  const { appendFileSync } = await import("node:fs");
  appendFileSync(".gtm/vendor-calls.log", domain + "\\n");
  return { industry: "Industry of " + domain, employees: domain.length };
}

async function collect(leads: Lead[], source: string) {
  const enriched: string[] = [], skipped: string[] = [], people: string[] = [];
  for (const lead of leads) {
    const person = await upsertPerson({ email: lead.email, linkedin: lead.linkedin, name: lead.name, company: { domain: lead.domain } }, { source });
    people.push(person.id);
    const company = { type: "company" as const, id: person.companyId! };
    if ((await stale(company, ["industry", "employees"], { maxAgeDays: 30 })).length) {
      await upsertCompany({ id: company.id, fields: await lookUp(lead.domain) }, { source: "vendor" });
      enriched.push(lead.domain);
    } else skipped.push(lead.domain);
    await upsertSignal({ about: company, type: "hiring", key: "careers-page", data: { seenBy: source } });
  }
  return { enriched, skipped, people };
}

export async function findLeads(input: { leads: Lead[] }) {
  "use workflow";
  return collect(input.leads, "lead-list");
}

export async function eventAttendees(input: { leads: Lead[] }) {
  "use workflow";
  return collect(input.leads, "event-list");
}
`, dir);
  write("workflows/index.ts", `import { eventAttendees, findLeads } from "./leads";\n${read("workflows/index.ts", dir)}`
    .replace("export const workflows = {", 'export const workflows = {\n  "find-leads": findLeads,\n  "event-attendees": eventAttendees,'), dir);
  assertOk(await revbound(["check"], { dir }), "revbound check with mdm");

  await startDev(dir);
  for (const p of ["/people", "/companies", "/signals"]) assert.equal((await get(p)).status, 200, p);
  assert.deepEqual((await json("/api/gtm/mdm/people")).data, []);
  assert.ok((await json("/api/gtm/data")).tables.some((x) => x.name === "gtm_mdm.people" && x.label === "MDM: people"));

  const first = await gtmRun(["find-leads", "--input", JSON.stringify({ leads: [
    { email: "jane@acme.example", name: "Jane Doe", domain: "acme.example" },
    { email: "bob@globex.example", name: "Bob", domain: "globex.example" },
    { email: "ann@acme.example", name: "Ann", domain: "https://acme.example/team" },
  ] })]);
  assert.equal(first.out?.status, "completed", tail(first.output));
  assert.deepEqual([first.out.returnValue.enriched, first.out.returnValue.skipped], [["acme.example", "globex.example"], ["https://acme.example/team"]]);
  const second = await gtmRun(["event-attendees", "--input", JSON.stringify({ leads: [
    { email: "JANE@acme.example", linkedin: "https://www.linkedin.com/in/jane-doe/", name: "Jane Doe", domain: "www.acme.example" },
    { email: "carol@globex.example", name: "Carol", domain: "https://www.globex.example/" },
    { linkedin: "linkedin.com/in/dan", name: "Dan", domain: "initech.example" },
  ] })]);
  assert.equal(second.out?.status, "completed", tail(second.output));
  assert.deepEqual([second.out.returnValue.enriched, second.out.returnValue.skipped], [["initech.example"], ["www.acme.example", "https://www.globex.example/"]],
    "the second run sees the first run's enrichment and skips it");
  assert.equal(second.out.returnValue.people[0], first.out.returnValue.people[0], "Jane is one person in both runs");
  assert.deepEqual(read(".gtm/vendor-calls.log", dir).trim().split("\n"), ["acme.example", "globex.example", "initech.example"], "each company enriched once");

  const people = (await json("/api/gtm/mdm/people")).data, companies = (await json("/api/gtm/mdm/companies")).data;
  assert.deepEqual(people.map((p) => p.name).sort(), ["Ann", "Bob", "Carol", "Dan", "Jane Doe"]);
  assert.deepEqual(companies.map((c) => c.domain).sort(), ["acme.example", "globex.example", "initech.example"]);
  assert.deepEqual(Object.fromEntries(companies.map((c) => [c.domain, c.people])), { "acme.example": 2, "globex.example": 2, "initech.example": 1 });
  const acme = companies.find((c) => c.domain === "acme.example");
  const page = await json(`/api/gtm/mdm/companies/${acme.id}`);
  const industry = page.fields.find((f) => f.field === "industry");
  assert.deepEqual([industry.value, industry.source, industry.workflow], ["Industry of acme.example", "vendor", "find-leads"]);
  assert.match(industry.runId, /^[0-9a-f-]{36}$/, "the ledger run that set it");
  assert.equal((await sql(dir, s.dbUrl, "select workflow from gtm_ledger.runs where id = $1", [industry.runId]))[0].workflow, "find-leads");
  assert.deepEqual(page.signals.map((x) => [x.type, x.source, x.data.seenBy]), [["hiring", "find-leads", "event-list"]], "one signal, found by both runs");
  assert.equal((await json("/api/gtm/mdm/signals")).data.length, 3);
  const jane = people.find((p) => p.name === "Jane Doe");
  const janePage = await json(`/api/gtm/mdm/people/${jane.id}`);
  assert.deepEqual(janePage.keys.map((k) => [k.key, k.value, k.source]), [["email", "jane@acme.example", "lead-list"], ["linkedin", "linkedin.com/in/jane-doe", "event-list"]]);
  for (const p of [`/people/${jane.id}`, `/companies/${acme.id}`, "/signals?type=hiring"]) assert.equal((await get(p)).status, 200, p);
  assert.equal((await get("/api/gtm/mdm/people/00000000-0000-0000-0000-000000000000")).status, 404);
  assertOk(await revbound(["check"], { dir }), "revbound check while dev runs");
  await stopDev();
  assertOk(await npm(["run", "build"], { dir }), "npm run build with mdm");
});
