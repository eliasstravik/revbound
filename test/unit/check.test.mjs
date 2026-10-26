/** Every `revbound check` rule on small projects, and what `revbound sync` generates (against the build: `npm run build` first). */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { rules } from "../../dist/core/check.js";
import { loadConfig } from "../../dist/core/config.js";
import { plan, stale, sync } from "../../dist/core/sync.js";
import { config, project, read, write } from "./project.mjs";

/** revbound check --build's errors and warnings for a project, after a sync unless `synced` is false. */
async function check(dir, { synced = true, build = true } = {}) {
  if (synced) await sync(dir, true);
  const c = await loadConfig(dir), p = await plan(dir, c);
  const results = await rules({ dir, config: c, plan: p, build, prod: false });
  return { errors: results.filter((r) => r.level === "error").map((r) => r.message),
    warnings: [...p.warnings, ...results.filter((r) => r.level === "warning").map((r) => r.message)] };
}
const has = (list, re) => assert.ok(list.some((m) => re.test(m)), `expected ${re} in:\n${list.join("\n")}`);
const lacks = (list, re) => assert.ok(!list.some((m) => re.test(m)), `did not expect ${re} in:\n${list.join("\n")}`);
/** A plugin literal for revbound.config.ts. */
const plugin = (fields) => `definePlugin(${JSON.stringify({ api: 1, ...fields })})`;
const defaults = ["database()", "ledger()", "workflows()", "ai()", "context()", "connections()", "console()"];

test("the starter with the seven defaults passes, and its generated files are current", async () => {
  const dir = project();
  const { errors } = await check(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(stale(dir, await plan(dir)), []);
  const pkg = JSON.parse(read(dir, "package.json"));
  assert.deepEqual(Object.keys(pkg.imports).sort(), ["#revbound/ai", "#revbound/database", "#revbound/ledger", "#revbound/workflows"]);
  assert.equal(JSON.parse(read(dir, "tsconfig.json")).compilerOptions.paths["#revbound/ai"][0], "./_revbound/ai.ts");
  assert.match(read(dir, "AGENTS.md"), /<!-- BEGIN:revbound -->[\s\S]*#revbound\/database[\s\S]*fanOut\(\)[\s\S]*<!-- END:revbound -->/);
  assert.match(read(dir, "proxy.ts"), /export default revboundProxy\(manifest\);/);
});

test("generated files make no top-level calls, and binding files reach heavy code only inside steps", async () => {
  const dir = project();
  await sync(dir, true);
  for (const f of fs.readdirSync(path.join(dir, "_revbound")).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
    const top = read(dir, `_revbound/${f}`).split("\n").filter((l) => /^\S/.test(l) && !/^(import|export|const|async function|function|\/\/|\/\*\*|\}|"use client";|once\.maxRetries = 0;)/.test(l));
    assert.deepEqual(top, [], `_revbound/${f} has top-level statements`);
  }
  const ai = read(dir, "_revbound/ai.ts");
  assert.match(ai, /async function step\(op: string, args: unknown\[\]\): Promise<unknown> \{\n {2}"use step";\n {2}const \[\{ run \}, \{ default: map \}\] = await Promise\.all\(\[import\("revbound\/ai\/step"\), import\("\.\/slots\/ai"\)\]\);/);
  assert.doesNotMatch(ai.replace(/async function (step|once)[\s\S]*?\n\}/g, ""), /import\(/, "no dynamic import outside a step");
  assert.doesNotMatch(read(dir, "_revbound/slots/ai.ts"), /database\/provide/, "ai's slot map holds only its own needs (the ledger's map reaches the database)");
  assert.match(read(dir, "_revbound/slots/ledger.ts"), /"database": \{ plugin: "database"/);
});

test("slots: unmet needs, two providers, a provider without provide, a capability without a ledger, a needs cycle", async () => {
  let dir = project({ "revbound.config.ts": config({ plugins: defaults.filter((p) => p !== "ledger()") }) });
  let { errors } = await check(dir);
  has(errors, /The workflows plugin needs the ledger slot, which no plugin provides/);
  has(errors, /The ai plugin needs the ledger slot/);
  has(errors, /The ai plugin spends, which needs the ledger/);

  dir = project({ "revbound.config.ts": config({ plugins: [...defaults, plugin({ name: "db2", provides: ["database"], provide: "./plugins/db2/provide" })] }) });
  has((await check(dir)).errors, /The database slot has two providers: database and db2/);

  dir = project({ "revbound.config.ts": config({ plugins: [...defaults, plugin({ name: "crm", provides: ["crm"] })] }) });
  has((await check(dir)).errors, /The crm plugin provides crm but has no `provide` module/);

  dir = project({ "revbound.config.ts": config({ plugins: [...defaults,
    plugin({ name: "a", provides: ["a"], provide: "./plugins/a/p", needs: ["b"] }), plugin({ name: "b", provides: ["b"], provide: "./plugins/b/p", needs: ["a"] })] }) });
  has((await check(dir)).errors, /needs form a cycle: (a → b → a|b → a → b)/);
});

test("replacements keep the default's runtime exports; the smallest set is database, ledger and workflows", async () => {
  let dir = project({ "revbound.config.ts": config({ plugins: [...defaults.filter((p) => p !== "ai()"), plugin({ name: "ai", needs: ["ledger"], capabilities: ["spends"], runtime: { from: "./plugins/ai/r", exports: ["agent"] } })] }) });
  has((await check(dir)).errors, /The ai plugin replaces the default ai but lacks its runtime exports tool/);
  dir = project({ "revbound.config.ts": config({ plugins: ["database()", "ledger()", "workflows()"] }) });
  const r = await check(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(read(dir, "app/[[...path]]/page.tsx").includes("notFound()"), true, "no console: a notFound() page");
  has(r.warnings, /No console plugin, so the views of database, ledger, workflows are not shown/);
});

test("the ledger guard: an edited ledger() fails unless acknowledged, and an acknowledged one is reported", async () => {
  const edited = "{ ...ledger(), provide: './plugins/ledger/provide' }";
  let dir = project({ "revbound.config.ts": config({ plugins: defaults.map((p) => (p === "ledger()" ? edited : p)) }) });
  has((await check(dir)).errors, /The ledger slot is not the package's own ledger\(\) \(provide differs\)/);
  dir = project({ "revbound.config.ts": config({ plugins: defaults.map((p) => (p === "ledger()" ? "{ ...ledger(), routes: [] }" : p)) }) });
  has((await check(dir)).errors, /route ledger\/reconcile differs/);
  dir = project({ "revbound.config.ts": config({ plugins: defaults.map((p) => (p === "ledger()" ? edited : p)), acknowledge: "acknowledge: { customLedger: true }," }) });
  lacks((await check(dir)).errors, /ledger slot is not/);
});

test("uniqueness: plugin names, CLI commands (also core ones), docs topics, workflow tabs, route and view patterns", async () => {
  const dir = project({ "revbound.config.ts": config({ plugins: [...defaults,
    plugin({ name: "context" }),
    plugin({ name: "x", cli: [{ name: "sync", describe: "d", run: "./plugins/x/c" }, { name: "migrate", describe: "d", run: "./plugins/x/c" }],
      docs: { plugins: "./plugins/x/d.md", data: "./plugins/x/d.md" }, workflowTabs: [{ id: "runs", title: "R", component: "./plugins/x/t" }],
      routes: [{ path: "runs/:run", methods: ["GET"], access: "automation", handler: "./plugins/x/h" }, { path: "data/:t", methods: ["GET"], access: "session", handler: "./plugins/x/h" }],
      views: [{ path: "data", title: "D", component: "./plugins/x/v" }, { path: "api/x", title: "A", component: "./plugins/x/v" }] }),
  ] }) });
  const { errors } = await check(dir);
  has(errors, /The plugin name "context" is declared by context and context/);
  has(errors, /The CLI command "sync" is declared by Revbound itself and x/);
  has(errors, /The CLI command "migrate" is declared by database and x/);
  has(errors, /The docs topic "plugins" is declared by Revbound itself and x/);
  has(errors, /The docs topic "data" is declared by database and x/);
  has(errors, /The workflow tab "runs" is declared by ledger and x/);
  has(errors, /The routes workflows:runs\/:id and x:runs\/:run can match the same path/);
  has(errors, /The routes database:data\/:table and x:data\/:t can match the same path/);
  has(errors, /The views database:data and x:data can match the same path/);
  has(errors, /The x view api\/x starts with a reserved segment/);
});

test("access: valid modes, read-only session routes, signature routes built with webhook()", async () => {
  write(project(), {});
  const dir = project({
    "plugins/x/hook.ts": "export default async function hook() { return new Response('ok'); }\n",
    "revbound.config.ts": config({ plugins: [...defaults, plugin({ name: "x", routes: [
      { path: "x/a", methods: ["POST"], access: "session", handler: "./plugins/x/h" },
      { path: "x/b", methods: ["GET"], access: "public", handler: "./plugins/x/h" },
      { path: "x/c", methods: ["POST"], access: "signature", handler: "./plugins/x/hook" }] })] }),
  });
  const { errors } = await check(dir);
  has(errors, /The x route x\/a is a session route that accepts POST/);
  has(errors, /The x route x\/b has access "public"/);
  has(errors, /The x route x\/c is a signature route not built with webhook\(\)/);
  lacks(errors, /hooks\/:name/);
});

test("registry: entries, approvals, schedules need both budgets, approvals ending within 14 days warn", async () => {
  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const dir = project({ "workflows/index.ts": `
async function a() { "use workflow"; return 1; }
export const workflows = {
  plain: a,
  approved: { run: a, approval: { required: true, previewItems: 2 }, budget: { perRunUsd: 2, perMonthUsd: 20 }, schedule: { approvedUntil: "${soon}", note: "weekly" } },
  nobudget: { run: a, schedule: { approvedUntil: "2099-01-01", note: "x" } },
  broken: { run: a, approval: { required: false }, colour: "red" },
  notfn: { description: "no run" },
};
`, "vercel.json": JSON.stringify({ crons: [{ path: "/api/revbound/ledger/reconcile", schedule: "0 * * * *" }, { path: "/api/revbound/cron/missing", schedule: "0 9 * * 1" }] }) });
  const { errors, warnings } = await check(dir);
  has(errors, /nobudget: a schedule needs budget\.perRunUsd and budget\.perMonthUsd/);
  has(errors, /broken: approval needs `required: true`/);
  has(errors, /broken has an unknown field "colour"/);
  has(errors, /notfn is neither a workflow function/);
  has(errors, /vercel\.json schedules \/api\/revbound\/cron\/missing, which is not in workflows\/index\.ts/);
  has(warnings, new RegExp(`approved: its schedule approval ends on ${soon}`));
  lacks(errors, /ledger\/reconcile/);
});

test("company code: no start from workflow/api, no AI SDK, plugins only through #revbound; type imports and ejected folders allowed", async () => {
  const dir = project({
    "workflows/a.ts": `import { start } from "workflow/api";\nimport { db } from "revbound/database";\nimport type { Api } from "revbound/ai/runtime";\nimport { agent } from "#revbound/ai";\nexport const x = [start, db, agent];\n`,
    "webhooks/b.ts": `import { generateText } from "ai";\nexport const y = generateText;\n`,
    "plugins/ai/runtime.ts": `import { generateText } from "ai";\nimport { x } from "revbound/ai/models";\nexport const z = [generateText, x];\n`,
    "plugins/other/index.ts": `import { start } from "workflow/api";\nimport { db } from "revbound/database";\nexport const w = [start, db];\n`,
  });
  const { errors } = await check(dir);
  has(errors, /workflows\/a\.ts:1 imports start from workflow\/api/);
  has(errors, /workflows\/a\.ts:2 imports revbound\/database directly/);
  has(errors, /webhooks\/b\.ts:1 imports "ai"/);
  has(errors, /plugins\/other\/index\.ts:1 imports start/);
  has(errors, /plugins\/other\/index\.ts:2 imports revbound\/database directly/);
  lacks(errors, /workflows\/a\.ts:3/);
  lacks(errors, /plugins\/ai\//);
});

test("generated files: a stale _revbound/ fails, a leftover binding fails, and sync fixes both", async () => {
  const dir = project();
  await sync(dir, true);
  write(dir, { "_revbound/routes.ts": "// edited\n", "_revbound/old.ts": "export {};\n" });
  const { errors } = await check(dir, { synced: false });
  has(errors, /Generated files are out of date: _revbound\/routes\.ts, _revbound\/old\.ts/);
  await sync(dir, true);
  assert.deepEqual((await check(dir, { synced: false })).errors, []);
  write(dir, { "package.json": read(dir, "package.json").replace('"revbound check --build && revbound migrate && next build"', '"next build"') });
  has((await check(dir)).errors, /package\.json's build script is "next build"/);
});

test(".gitignore: a missing line fails; a Vercel build without the file (as `vercel deploy` uploads it) passes", async () => {
  const dir = project();
  write(dir, { ".gitignore": "node_modules/\n" });
  has((await check(dir)).errors, /\.gitignore lacks `\.env\*\.local`/);
  fs.rmSync(path.join(dir, ".gitignore"));
  has((await check(dir)).errors, /\.gitignore lacks/);
  process.env.VERCEL = "1";
  try { lacks((await check(dir)).errors, /\.gitignore/); } finally { delete process.env.VERCEL; }
});

test("an unknown plugin API version refuses to load, with a clear message", async () => {
  const dir = project({ "revbound.config.ts": config({ plugins: [...defaults, "{ name: 'future', api: 2 }"] }) });
  await assert.rejects(loadConfig(dir), /The future plugin speaks plugin API 2; this Revbound speaks API 1/);
});

test("mdm, the optional plugin: sync wires #revbound/mdm, its views, tables, skill and docs; check passes; it needs the ledger and the database", async () => {
  const imports = 'import { mdm } from "revbound/mdm";';
  let dir = project({ "revbound.config.ts": config({ imports, plugins: [...defaults, "mdm()"] }) });
  assert.deepEqual((await check(dir)).errors, []);
  assert.equal(JSON.parse(read(dir, "package.json")).imports["#revbound/mdm"], "./_revbound/mdm.ts");
  const binding = read(dir, "_revbound/mdm.ts");
  for (const name of ["upsertCompany", "upsertPerson", "upsertSignal", "findPerson", "merge", "known", "stale"]) assert.match(binding, new RegExp(`export const ${name}: Api\\["${name}"\\]`));
  assert.match(binding, /import\("revbound\/mdm\/step"\)/);
  assert.match(read(dir, "_revbound/slots/mdm.ts"), /"mdm": \{ plugin: "mdm"[\s\S]*"database": \{ plugin: "database"[\s\S]*"workflows": \{ plugin: "workflows"/);
  const manifest = read(dir, "_revbound/manifest.ts");
  for (const needle of ['"path": "people"', '"path": "companies"', '"path": "signals"', '"name": "people"', '"schema": "revbound_mdm"', '"key": "mdm:mdm/people/:id"']) assert.ok(manifest.includes(needle), needle);
  assert.match(read(dir, "_revbound/views.tsx"), /import \{ PeopleView as C\d+ \} from "revbound\/mdm\/views";/);
  assert.match(read(dir, ".agents/skills/mdm-records/SKILL.md"), /^---\nname: mdm-records\n/);
  assert.match(read(dir, "AGENTS.md"), /upsertPerson[\s\S]*stale\(record, fields/);
  dir = project({ "revbound.config.ts": config({ imports, plugins: ["database()", "mdm()"] }) });
  has((await check(dir)).errors, /The mdm plugin writesPeople, which needs the ledger, and no plugin provides it/);
  dir = project({ "revbound.config.ts": config({ imports, plugins: ["ledger()", "mdm()"] }) });
  has((await check(dir)).errors, /The mdm plugin needs the database slot/);
});
