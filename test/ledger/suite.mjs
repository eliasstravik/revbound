/**
 * The ledger's rules on a real database: admit, approvals, caps, reserve and settle, the spend-point rule, reconcile.
 * The workflows slot is a stand-in that answers from `sdk` (SDK runs by id) and `registry`. Each test uses its own
 * workflow names, so month sums never mix. Run by ledger-postgres.test.mjs and ledger-pglite.test.mjs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const dist = (p) => import(path.join(REPO, "dist", p));

export async function suite({ url, concurrent }) {
  process.env.DATABASE_URL = url;
  const { applyPlan } = await dist("plugins/database/migrate.js");
  const provideDb = (await dist("plugins/database/provide.js")).default;
  const provideLedger = (await dist("plugins/ledger/provide.js")).default;
  const { NEEDS_YES } = await dist("plugins/ledger/provide.js");
  const folder = (p) => path.join(REPO, "src", "plugins", p, "migrations");
  await applyPlan({ sets: [{ id: "database", schema: "gtm", folder: folder("database") }, { id: "ledger", schema: "gtm_ledger", folder: folder("ledger") },
    { id: "workflows", schema: "gtm_workflows", folder: folder("workflows") }], destructive: [] }, url);

  const registry = {}, sdk = new Map();
  const workflows = {
    registry: async () => registry,
    getRun: async (id) => sdk.get(id) ?? null,
    listRuns: async (since) => [...sdk.values()].filter((r) => since === "-infinity" || r.createdAt >= since),
  };
  const database = provideDb({});
  const manifest = { connections: [{ name: "ACME_KEY", label: "", plugins: [] }], plugins: [] };
  const ledger = provideLedger({ manifest, plugin: "ledger", options: { budgets: { perRunUsd: 25, perWorkflowMonthUsd: 10_000, projectMonthUsd: 100_000 } },
    has: () => true, get: (s) => (s === "database" ? database : workflows), module: async () => ({}) });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async (text, values) => (await client.query(text, values)).rows;
  let n = 0;
  /** A fresh workflow name, registered with `info`. */
  const wf = (info = {}) => { const name = `w${Date.now().toString(36)}${(n += 1)}`; registry[name] = info; return name; };
  /** Admits and "starts" a run: an SDK run with Revbound's attributes, linked. */
  const begin = async (request, { status = "running", attrs = true } = {}) => {
    const a = await ledger.admit(request);
    assert.ok(a.ok, `admit refused: ${a.reason}`);
    if (a.existing) return { ...a, sdkRunId: a.existing };
    const sdkRunId = `wrun_${randomUUID()}`;
    sdk.set(sdkRunId, { sdkRunId, workflow: request.workflow, status, createdAt: new Date().toISOString(), completedAt: null, attributes: attrs ? { gtm_run_id: a.runId } : {}, error: null });
    await ledger.started(a.runId, sdkRunId);
    return { ...a, sdkRunId };
  };
  const finish = async (run, status = "completed") => {
    sdk.get(run.sdkRunId).status = status;
    sdk.get(run.sdkRunId).completedAt = new Date().toISOString();
    await ledger.refreshRun(run.runId);
  };
  const spend = (run, usd, key = randomUUID(), holder) => ledger.reserve({ sdkRunId: run.sdkRunId, plugin: "test", kind: "paid_api", idempotencyKey: key, estimateUsd: usd, holder });
  const treeUsd = async (rootId) => Number((await q("select coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8 as usd from gtm_ledger.actions where root_run_id = $1", [rootId]))[0].usd);

  test("admit commits a row before start; start_failed voids it; a refused start is recorded with the 403 text", async () => {
    const plain = wf(), needs = wf({ approval: { required: true } });
    const a = await ledger.admit({ workflow: plain, input: { a: 1 }, trigger: "cli" });
    assert.equal((await q("select status from gtm_ledger.runs where id = $1", [a.runId]))[0].status, "admitted");
    await ledger.startFailed(a.runId, new Error(`boom with ${process.env.ACME_KEY = "acme-secret-value"}`));
    const row = (await q("select status, reason from gtm_ledger.runs where id = $1", [a.runId]))[0];
    assert.equal(row.status, "start_failed");
    assert.ok(row.reason.includes("[redacted]") && !row.reason.includes("acme-secret-value"), row.reason);
    const r = await ledger.admit({ workflow: needs, input: {}, trigger: "cli" });
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(NEEDS_YES), r.reason);
    assert.match(NEEDS_YES, /^This workflow needs a person's yes\. Run a preview, show the person the sample and the cost, and ask Yes\/No in chat\. Only after a yes, run it again with `--approve --max-usd`\.$/);
    assert.equal((await q("select status from gtm_ledger.runs where id = $1", [r.runId]))[0].status, "refused");
  });

  test("--approve rests on a completed preview of the same input; a fan-out preview completes only when its children are final", async () => {
    const name = wf({ approval: { required: true, previewItems: 2 } }), child = wf();
    const input = { list: [1, 2, 3], b: "x" }, same = { b: "x", list: [1, 2, 3] };
    assert.equal((await ledger.admit({ workflow: name, input, trigger: "cli", approve: { maxUsd: 5 } })).ok, false, "no preview yet");
    const preview = await begin({ workflow: name, input, trigger: "cli", preview: true });
    assert.equal(preview.preview, true);
    const kid = await begin({ workflow: child, input: 1, trigger: "child", parent: { runId: preview.runId, childKey: `${preview.runId}:0` } });
    await finish(preview);
    assert.equal((await ledger.admit({ workflow: name, input: same, trigger: "cli", approve: { maxUsd: 5 } })).ok, false, "a child still runs");
    await finish(kid);
    for (const maxUsd of [0.005, 1.234, 0]) {
      const odd = await ledger.admit({ workflow: name, input: same, trigger: "cli", approve: { maxUsd } });
      assert.equal(odd.ok, false, `an approval of $${maxUsd} is never rounded`);
      assert.match(odd.reason, /in whole cents, \$0\.01 or more/);
    }
    const ok = await ledger.admit({ workflow: name, input: same, trigger: "cli", approve: { maxUsd: 5, note: "yes in chat" } });
    assert.ok(ok.ok && ok.approved, ok.reason);
    const row = (await q("select approved_max_usd::float8 as cap, approval_note, approved_by_preview from gtm_ledger.runs where id = $1", [ok.runId]))[0];
    assert.deepEqual(row, { cap: 5, approval_note: "yes in chat", approved_by_preview: preview.runId });
    assert.equal((await ledger.admit({ workflow: name, input: { other: true }, trigger: "cli", approve: { maxUsd: 5 } })).ok, false, "another input");
  });

  test("a preview admits at most previewItems children; a retried child_key starts no duplicate", async () => {
    const name = wf({ approval: { required: true, previewItems: 2 } }), child = wf();
    const root = await begin({ workflow: name, input: {}, trigger: "cli", preview: true });
    const c0 = await begin({ workflow: child, input: 0, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:0` } });
    const again = await ledger.admit({ workflow: child, input: 0, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:0` } });
    assert.equal(again.existing, c0.sdkRunId, "the child already started");
    const other = await ledger.admit({ workflow: wf(), input: 9, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:0` } });
    assert.equal(other.ok, false, "a key that started another child never hands that child out");
    assert.match(other.reason, /already started another child/);
    await begin({ workflow: child, input: 1, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:1` } });
    const third = await ledger.admit({ workflow: child, input: 2, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:2` } });
    assert.equal(third.ok, false);
    assert.match(third.reason, /at most 2 children/);
    assert.equal(Number((await q("select count(*) from gtm_ledger.runs where root_run_id = $1 and status <> 'refused'", [root.runId]))[0].count), 3);
  });

  test("a child whose start failed starts again on retry; costs that are not $0 or more never lower spend", async () => {
    const root = await begin({ workflow: wf(), input: {}, trigger: "cli" }), child = wf(), key = `${root.runId}:0`;
    const first = await ledger.admit({ workflow: child, input: 0, trigger: "child", parent: { runId: root.runId, childKey: key } });
    await ledger.startFailed(first.runId, new Error("transient"));
    const retry = await ledger.admit({ workflow: child, input: 0, trigger: "child", parent: { runId: root.runId, childKey: key } });
    assert.ok(retry.ok && !retry.existing && retry.runId === first.runId, "the retry starts the same child");
    assert.equal((await ledger.getRun(first.runId)).status, "admitted");
    for (const bad of [-100, NaN, Infinity]) {
      const run = await begin({ workflow: wf(), input: {}, trigger: "cli" });
      const r = await spend(run, 20);
      await ledger.settle(r.id, { costUsd: bad, outcome: "ok" });
      assert.equal(await treeUsd(run.runId), 20, `${bad}: the reservation stays what the call spent`);
      assert.equal((await spend(run, 10)).ok, false, `${bad}: the run's $25 cap still holds`);
    }
  });

  test("schedules: cron starts are refused before and accepted after approvedUntil; webhooks never start approval-required work", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const old = wf({ approval: { required: true }, budget: { perRunUsd: 3, perMonthUsd: 30 }, schedule: { approvedUntil: yesterday, note: "weekly" } });
    const fresh = wf({ approval: { required: true }, budget: { perRunUsd: 3, perMonthUsd: 30 }, schedule: { approvedUntil: later, note: "weekly" } });
    const today = wf({ approval: { required: true }, budget: { perRunUsd: 3, perMonthUsd: 30 }, schedule: { approvedUntil: new Date().toISOString().slice(0, 10), note: "x" } });
    const r = await ledger.admit({ workflow: old, input: undefined, trigger: "cron" });
    assert.equal(r.ok, false);
    assert.match(r.reason, new RegExp(`ended on ${yesterday}`));
    const ok = await ledger.admit({ workflow: fresh, input: undefined, trigger: "cron" });
    assert.ok(ok.ok && ok.approved);
    assert.deepEqual((await q("select approved_max_usd::float8 as cap, approval_note from gtm_ledger.runs where id = $1", [ok.runId]))[0], { cap: 3, approval_note: `schedule until ${later}: weekly` });
    assert.ok((await ledger.admit({ workflow: today, input: undefined, trigger: "cron" })).ok, "approvedUntil today still counts");
    const hook = await ledger.admit({ workflow: fresh, input: {}, trigger: "webhook" });
    assert.equal(hook.ok, false);
    assert.ok(hook.reason.startsWith(NEEDS_YES));
  });

  test("caps: 800 children with a $25 per-run cap under a $100 root approval stop at $100 in total", async () => {
    const parent = wf(), child = wf();
    const root = await begin({ workflow: parent, input: {}, trigger: "cli", approve: { maxUsd: 100 } });
    let refused = 0;
    for (let i = 0; i < 800; i += 1) {
      const c = await begin({ workflow: child, input: i, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:${i}` } });
      const r = await spend(c, 0.5);
      if (!r.ok) { refused += 1; assert.match(r.reason, /approved total of \$100/); }
    }
    assert.equal(await treeUsd(root.runId), 100);
    assert.equal(refused, 600);
    const one = await begin({ workflow: wf(), input: {}, trigger: "cli" });
    assert.ok((await spend(one, 20)).ok);
    const over = await spend(one, 6);
    assert.equal(over.ok, false);
    assert.match(over.reason, /pass its \$25 budget/);
  });

  test("month caps hold under concurrent roots, and 20 concurrent children add no overspend", { skip: !concurrent && "concurrency is proven on real Postgres" }, async () => {
    const capped = wf({ budget: { perMonthUsd: 10 } });
    const roots = await Promise.all(Array.from({ length: 30 }, () => begin({ workflow: capped, input: randomUUID(), trigger: "cli" })));
    const results = await Promise.all(roots.map((r) => spend(r, 1)));
    assert.equal(results.filter((r) => r.ok).length, 10);
    const spent = Number((await q("select coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8 as usd from gtm_ledger.actions where workflow = $1", [capped]))[0].usd);
    assert.equal(spent, 10);
    const parent = wf(), child = wf();
    const root = await begin({ workflow: parent, input: {}, trigger: "cli", approve: { maxUsd: 10 } });
    const kids = await Promise.all(Array.from({ length: 20 }, (_, i) => begin({ workflow: child, input: i, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:${i}` } })));
    const res = await Promise.all(kids.map((k) => spend(k, 1)));
    await Promise.all(res.filter((r) => r.ok).map((r) => ledger.settle(r.id, { costUsd: 1, outcome: "ok" })));
    assert.equal(res.filter((r) => r.ok).length, 10);
    assert.equal(await treeUsd(root.runId), 10);
  });

  test("reserve and settle: each retried attempt counts; done-before only after ok; reruns after failed; a reserved row runs again", async () => {
    const run = await begin({ workflow: wf(), input: {}, trigger: "cli" });
    for (const attempt of [1, 2]) assert.ok((await spend(run, 0.1, `${run.sdkRunId}:step_1:${attempt}`)).ok);
    assert.equal(Number((await q("select count(*) from gtm_ledger.actions where run_id = $1", [run.runId]))[0].count), 2);
    const key = `enrich:${randomUUID()}`;
    const first = await spend(run, 0.2, key, { step: "step_a", attempt: 1 });
    assert.ok(first.ok && !first.repeat);
    const twin = await spend(run, 0.2, key, { step: "step_a", attempt: 1 });
    assert.equal(twin.ok, false, "the same attempt calling twice at once never runs twice on one reservation");
    assert.match(twin.reason, /in use by another call that has not finished/);
    assert.equal((await spend(run, 0.2, key, { step: "step_b", attempt: 1 })).ok, false, "another step never borrows it");
    assert.equal((await spend(run, 0.2, key)).ok, false, "nor a call that names no step");
    assert.equal((await spend(run, 0.2, key, { step: "step_a", attempt: 2 })).repeat, "reserved", "a crash mid-call: the step's retry runs again on it");
    assert.equal((await spend(run, 0.2, key, { step: "step_a", attempt: 2 })).ok, false, "and holds it from then on");
    await ledger.settle(first.id, { outcome: "failed" });
    const retry = await spend(run, 0.2, key);
    assert.ok(retry.ok && !retry.repeat && retry.id !== first.id, "after failed: a new attempt row");
    assert.deepEqual((await q("select idempotency_key, attempt from gtm_ledger.actions where id = $1", [retry.id]))[0], { idempotency_key: key, attempt: 2 });
    await ledger.settle(retry.id, { costUsd: 0.15, outcome: "ok" });
    assert.equal((await spend(run, 0.2, key)).repeat, "ok", "after ok: done-before");
    const failed = (await q("select cost_usd, reserved_usd::float8 as r from gtm_ledger.actions where id = $1", [first.id]))[0];
    assert.deepEqual(failed, { cost_usd: null, r: 0.2 }, "a failed call with no known cost keeps its reservation counted");
    const leaky = await spend(run, 0.01);
    await ledger.settle(leaky.id, { outcome: "failed", detail: { error: `vendor said no to ${process.env.ACME_KEY}` } });
    const detail = (await q("select detail from gtm_ledger.actions where id = $1", [leaky.id]))[0].detail;
    assert.equal(detail.error, "vendor said no to [redacted]", "a declared connection's value never lands in the ledger");
    const unmetered = await ledger.reserve({ sdkRunId: run.sdkRunId, plugin: "ai", kind: "model_call", idempotencyKey: randomUUID(), estimateUsd: null });
    assert.ok(unmetered.ok);
    await ledger.settle(unmetered.id, { costUsd: null, outcome: "ok" });
    const got = await ledger.getRun(run.runId);
    assert.equal(got.unmetered, 1);
  });

  test("distinct keys each run, even when one looks like another's retry", async () => {
    const run = await begin({ workflow: wf(), input: {}, trigger: "cli" });
    const base = `invoice:${randomUUID()}`;
    for (const key of [`${base}#2`, base, `${base}#%`, `${base}_`]) {
      const r = await spend(run, 0.1, key);
      assert.ok(r.ok && !r.repeat, `${key} reserves its own row`);
      await ledger.settle(r.id, { costUsd: 0.1, outcome: "ok" });
    }
    const failed = await spend(run, 0.1, `${base}:b`);
    await ledger.settle(failed.id, { outcome: "failed" });
    const plain = await spend(run, 0.1, `${base}:b#2`);
    assert.ok(plain.ok && !plain.repeat, "a key shaped like another's next attempt is still its own key");
    const again = await spend(run, 0.1, `${base}:b`);
    assert.ok(again.ok && !again.repeat && ![failed.id, plain.id].includes(again.id), "and the failed key's retry gets its own attempt row");
    assert.equal((await spend(run, 0.1, `${base}#2`)).repeat, "ok", "a finished key is still done-before");
  });

  test("the spend-point rule: children of unapproved roots, external runs and re-runs that copy attributes are refused", async () => {
    const needs = wf({ approval: { required: true } }), plain = wf();
    const root = await begin({ workflow: plain, input: {}, trigger: "cli" });
    const kid = await ledger.admit({ workflow: needs, input: 1, trigger: "child", parent: { runId: root.runId, childKey: `${root.runId}:0` } });
    assert.equal(kid.ok, false, "admit refuses an approval-required child of an unapproved root");
    assert.ok(kid.reason.startsWith(NEEDS_YES));
    const outside = `wrun_${randomUUID()}`;
    sdk.set(outside, { sdkRunId: outside, workflow: needs, status: "running", createdAt: new Date().toISOString(), completedAt: null, attributes: {} });
    const ext = await ledger.reserve({ sdkRunId: outside, plugin: "ai", kind: "model_call", idempotencyKey: randomUUID(), estimateUsd: 0.01 });
    assert.equal(ext.ok, false);
    assert.equal((await q("select trigger, root_run_id = id as own from gtm_ledger.runs where sdk_run_id = $1", [outside]))[0].trigger, "external");
    assert.equal((await q("select outcome from gtm_ledger.actions where id = $1", [ext.id]))[0].outcome, "blocked");
    const approved = await begin({ workflow: wf({ approval: { required: true } }), input: {}, trigger: "cron" }).catch(() => undefined);
    void approved;
    const yes = wf({ approval: { required: true }, budget: { perRunUsd: 5, perMonthUsd: 50 }, schedule: { approvedUntil: "2999-01-01", note: "x" } });
    const real = await begin({ workflow: yes, input: undefined, trigger: "cron" });
    assert.ok((await spend(real, 0.5)).ok, "the approved run itself spends");
    const copy = `wrun_${randomUUID()}`;
    sdk.set(copy, { sdkRunId: copy, workflow: yes, status: "running", createdAt: new Date().toISOString(), completedAt: null, attributes: { gtm_run_id: real.runId } });
    const rerun = await ledger.reserve({ sdkRunId: copy, plugin: "ai", kind: "model_call", idempotencyKey: randomUUID(), estimateUsd: 0.01 });
    assert.equal(rerun.ok, false, "a re-run with copied attributes is its own external, unapproved root");
  });

  test("an unapproved run never borrows another run's open reservation, and a key is never re-run above its reservation", async () => {
    const paid = wf({ approval: { required: true, previewMaxUsd: 1 } });
    const p = await begin({ workflow: paid, input: {}, trigger: "cli", preview: true });
    const held = await spend(p, 0.5, "vendor-stable-key");
    assert.ok(held.ok && !held.repeat);
    const outside = `wrun_${randomUUID()}`;
    sdk.set(outside, { sdkRunId: outside, workflow: paid, status: "running", createdAt: new Date().toISOString(), completedAt: null, attributes: {} });
    const fresh = await ledger.reserve({ sdkRunId: outside, plugin: "company", kind: "paid_api", idempotencyKey: randomUUID(), estimateUsd: 1 });
    assert.equal(fresh.ok, false);
    const borrowed = await ledger.reserve({ sdkRunId: outside, plugin: "company", kind: "paid_api", idempotencyKey: "vendor-stable-key", estimateUsd: 100 });
    assert.equal(borrowed.ok, false, "the approval check comes before any same-key repeat");
    const plainName = wf(), plain = await begin({ workflow: plainName, input: {}, trigger: "cli" });
    const other = await begin({ workflow: plainName, input: 2, trigger: "cli" });
    const mine = await spend(plain, 0.5, "shared-key", { step: "s", attempt: 1 });
    assert.ok(mine.ok);
    const theirs = await spend(other, 0.5, "shared-key");
    assert.equal(theirs.ok, false);
    assert.match(theirs.reason, /reserved by another run that has not finished/);
    const bigger = await spend(plain, 5, "shared-key", { step: "s", attempt: 2 });
    assert.equal(bigger.ok, false);
    assert.match(bigger.reason, /above this key's open reservation/);
    assert.equal((await spend(plain, 0.5, "shared-key", { step: "s", attempt: 2 })).repeat, "reserved", "the same step's retry re-runs a crashed call at its reservation");
  });

  test("an unreadable registry refuses every spend and start instead of dropping approvals and budgets", async () => {
    const paid = wf({ approval: { required: true } });
    const run = await begin({ workflow: wf(), input: {}, trigger: "cli" });
    const registry = workflows.registry;
    workflows.registry = async () => { throw new Error("registry broke"); };
    try {
      const r = await spend(run, 0.1);
      assert.equal(r.ok, false);
      assert.match(r.reason, /the workflow registry could not be read \(registry broke\)/);
      const a = await ledger.admit({ workflow: paid, input: {}, trigger: "cli" });
      assert.equal(a.ok, false);
      assert.match(a.reason, /registry could not be read/);
    } finally {
      workflows.registry = registry;
    }
  });

  test("a preview counts calls and spend tree-wide, and refuses one call above its cap", async () => {
    const name = wf({ approval: { required: true, previewCalls: 3, previewMaxUsd: 1 } });
    const p = await begin({ workflow: name, input: {}, trigger: "cli", preview: true });
    const big = await spend(p, 1.5);
    assert.equal(big.ok, false);
    assert.match(big.reason, /above the preview cap of \$1; raise approval\.previewMaxUsd/);
    for (let i = 0; i < 3; i += 1) assert.ok((await ledger.reserve({ sdkRunId: p.sdkRunId, plugin: "ai", kind: "model_call", idempotencyKey: randomUUID(), estimateUsd: null })).ok);
    const fourth = await ledger.reserve({ sdkRunId: p.sdkRunId, plugin: "ai", kind: "model_call", idempotencyKey: randomUUID(), estimateUsd: null });
    assert.equal(fourth.ok, false);
    assert.match(fourth.reason, /at most 3 metered or plan calls.*currentRun\(\)\.preview/);
  });

  test("reconcile: the throttle, links, external discovery, refresh, unknown, start_failed timeout, settling reservations", async () => {
    await q("update gtm_ledger.meta set value = '-infinity' where key = 'reconcile_at'");
    const name = wf();
    const linked = await ledger.admit({ workflow: name, input: {}, trigger: "http" });
    const sdkLinked = `wrun_${randomUUID()}`;
    sdk.set(sdkLinked, { sdkRunId: sdkLinked, workflow: name, status: "completed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attributes: { gtm_run_id: linked.runId } });
    const outsider = `wrun_${randomUUID()}`;
    sdk.set(outsider, { sdkRunId: outsider, workflow: name, status: "failed", createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attributes: {} });
    const gone = await begin({ workflow: name, input: 2, trigger: "cli" });
    const spentRun = await begin({ workflow: name, input: 3, trigger: "cli" });
    const open = await spend(spentRun, 0.3);
    sdk.delete(gone.sdkRunId);
    sdk.get(spentRun.sdkRunId).status = "failed";
    const stuck = await ledger.admit({ workflow: name, input: 4, trigger: "cli" });
    await q("update gtm_ledger.runs set started_at = now() - interval '11 minutes' where id = $1", [stuck.runId]);
    // Earlier tests leave many runs going; a pass refreshes only the 50 oldest.
    await q("update gtm_ledger.runs set status = 'completed' where status = 'running' and id <> all($1)", [[gone.runId, spentRun.runId]]);
    const pass = await ledger.reconcile();
    assert.equal(pass.ran, true);
    assert.equal((await ledger.reconcile()).ran, false, "one pass a minute");
    const status = async (id) => (await q("select status from gtm_ledger.runs where id = $1", [id]))[0].status;
    assert.equal((await q("select sdk_run_id from gtm_ledger.runs where id = $1", [linked.runId]))[0].sdk_run_id, sdkLinked, "linked by its attributes");
    assert.deepEqual((await q("select trigger, status from gtm_ledger.runs where sdk_run_id = $1", [outsider]))[0], { trigger: "external", status: "failed" });
    assert.equal(await status(gone.runId), "unknown", "its SDK record is gone");
    assert.equal(await status(spentRun.runId), "failed");
    assert.equal(await status(stuck.runId), "start_failed");
    assert.equal((await q("select outcome from gtm_ledger.actions where id = $1", [open.id]))[0].outcome, "unknown", "a reservation on an ended run stays counted as unknown");
    assert.notEqual((await q("select value from gtm_ledger.meta where key = 'reconcile_cursor'"))[0].value, "-infinity", "the cursor moved");
    await q("update gtm_ledger.meta set value = '-infinity' where key = 'reconcile_at'");
    assert.equal((await ledger.reconcile()).external, 0, "a second pass inserts nothing twice");
  });

  test("reconcile: refresh takes running rows in turn, so 50 older open runs never hide a newer finished one", async () => {
    await q("update gtm_ledger.runs set status = 'completed' where status = 'running'");
    const name = wf();
    for (let i = 0; i < 50; i += 1) await begin({ workflow: name, input: { old: i }, trigger: "cli" });
    await q("update gtm_ledger.runs set started_at = now() - interval '1 hour' where workflow = $1", [name]);
    const newer = await begin({ workflow: name, input: { newer: true }, trigger: "cli" });
    sdk.get(newer.sdkRunId).status = "completed";
    const status = async () => (await q("select status from gtm_ledger.runs where id = $1", [newer.runId]))[0].status;
    for (let pass = 0; pass < 2 && (await status()) === "running"; pass += 1) {
      await q("update gtm_ledger.meta set value = '-infinity' where key = 'reconcile_at'");
      assert.equal((await ledger.reconcile()).refreshed, 50);
    }
    assert.equal(await status(), "completed", "refreshed within two passes");
    await q("update gtm_ledger.runs set status = 'completed' where status = 'running'");
  });

  test("the views: run_costs per run and per tree, spend_by_workflow_month", async () => {
    const name = wf();
    const root = await begin({ workflow: name, input: {}, trigger: "cli" });
    const r = await spend(root, 0.25);
    await ledger.settle(r.id, { costUsd: 0.2, outcome: "ok" });
    const row = (await q("select cost_usd::float8 as c, tree_cost_usd::float8 as t, calls from gtm_ledger.run_costs where run_id = $1", [root.runId]))[0];
    assert.deepEqual(row, { c: 0.2, t: 0.2, calls: "1" });
    assert.equal(Number((await q("select cost_usd from gtm_ledger.spend_by_workflow_month where workflow = $1", [name]))[0].cost_usd), 0.2);
  });

  test("teardown", async () => { await client.end(); await database.db().$client.end(); });
}
