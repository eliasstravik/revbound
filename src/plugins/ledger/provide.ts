/**
 * The `ledger` slot (LedgerSlotV1): admit and record every start, reserve and settle every metered action, keep
 * statuses fresh, reconcile. Any transaction that checks or changes spend takes one project-wide advisory lock and
 * holds no network call; admit and reserve fail closed.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Admission, Ctx, LedgerRun, LedgerSlotV1, Limits, Reservation, ReserveRequest, RunStatus, SdkRun } from "revbound";

/** The 403 every refused start of an approval-required workflow opens with. */
export const NEEDS_YES = "This workflow needs a person's yes. Run a preview, show the person the sample and the cost, and ask Yes/No in chat. " +
  "Only after a yes, run it again with `--approve --max-usd`.";
const LOCK = sql`select pg_advisory_xact_lock(hashtext('revbound-budget'))`;
const FINAL: RunStatus[] = ["completed", "failed", "cancelled", "unknown", "refused", "start_failed"];
const SPENT = sql`coalesce(sum(coalesce(cost_usd, reserved_usd)), 0)::float8`;
const DEFAULTS = { perRunUsd: 25, perWorkflowMonthUsd: 300, projectMonthUsd: 1000 };

export type LedgerOptions = { budgets?: Partial<typeof DEFAULTS> };
type Exec = { execute: (q: SQL) => Promise<{ rows: Record<string, any>[] }> };

/** RFC 8785 canonical JSON: sorted keys, ECMAScript number and string forms, no whitespace. */
export function canonical(v: unknown): string {
  if (v === undefined || v === null || typeof v === "function") return "null";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("Inputs cannot hold NaN or Infinity."); return JSON.stringify(v); }
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const keys = Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const inputHash = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");

const num = (v: unknown) => (v == null ? null : Number(v));
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
function toRun(r: Record<string, any>): LedgerRun {
  return {
    id: r.id, sdkRunId: r.sdk_run_id, workflow: r.workflow, trigger: r.trigger, preview: r.preview, status: r.status, reason: r.reason,
    parentRunId: r.parent_run_id, rootRunId: r.root_run_id, approvedMaxUsd: num(r.approved_max_usd), approvalNote: r.approval_note,
    startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at), costUsd: Number(r.cost_usd ?? 0),
    reservedUsd: Number(r.reserved_usd ?? 0), calls: Number(r.calls ?? 0), unmetered: Number(r.unmetered ?? 0),
  };
}
const RUN = sql`select r.*, coalesce(c.cost, 0) as cost_usd, coalesce(c.reserved, 0) as reserved_usd, coalesce(c.calls, 0)::int as calls,
  coalesce(c.unmetered, 0)::int as unmetered
  from revbound_ledger.runs r left join lateral (select sum(coalesce(a.cost_usd, a.reserved_usd))::float8 as cost,
    sum(a.reserved_usd) filter (where a.outcome = 'reserved')::float8 as reserved, count(*) filter (where a.outcome <> 'blocked') as calls,
    count(*) filter (where a.outcome <> 'blocked' and a.cost_usd is null and a.reserved_usd is null) as unmetered
    from revbound_ledger.actions a where a.run_id = r.id) c on true`;

/** `text` with every value of a declared connection replaced by [redacted], cut to 500 characters. */
function redact(ctx: Ctx, text: string): string {
  let s = text;
  for (const c of ctx.manifest.connections) {
    const v = process.env[c.name];
    if (v && v.length >= 4) s = s.replaceAll(v, "[redacted]");
  }
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

/** `detail` as JSON with every string redacted (and cut to 500 characters). */
const redactJson = (ctx: Ctx, detail: Record<string, unknown>) =>
  JSON.stringify(detail, (_k, v: unknown) => (typeof v === "string" ? redact(ctx, v) : v));

const SDK_STATUS: Record<SdkRun["status"], RunStatus> = { pending: "running", running: "running", completed: "completed", failed: "failed", cancelled: "cancelled" };

export default function provide(ctx: Ctx): LedgerSlotV1 {
  const db = () => ctx.get("database").db() as unknown as Exec & { transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> };
  const opts = (ctx.options ?? {}) as LedgerOptions, budgets = { ...DEFAULTS, ...opts.budgets };
  const rows = async (q: SQL, tx: Exec = db()) => (await tx.execute(q)).rows;
  const one = async (q: SQL, tx?: Exec) => (await rows(q, tx))[0];
  const workflows = () => (ctx.has("workflows") ? ctx.get("workflows") : undefined);

  const limitsFor = async (workflow: string): Promise<Limits> => {
    // Fail closed: when the registry cannot be read, approvals and budgets are unknown, so the caller refuses.
    const registry = await workflows()?.registry().catch((error: Error) => {
      throw new Error(`the workflow registry could not be read (${error?.message ?? error})`);
    });
    const info = registry?.[workflow] ?? {};
    const a = info.approval;
    return {
      approval: { required: a?.required === true, previewItems: a?.previewItems ?? 3, previewCalls: a?.previewCalls ?? 10, previewMaxUsd: a?.previewMaxUsd ?? 1, previewWithinHours: a?.previewWithinHours ?? 24 },
      perRunUsd: info.budget?.perRunUsd ?? budgets.perRunUsd, perMonthUsd: info.budget?.perMonthUsd ?? budgets.perWorkflowMonthUsd,
      projectMonthUsd: budgets.projectMonthUsd, ...(info.schedule && { schedule: info.schedule }),
    };
  };
  const getRun = async (id: string, tx?: Exec) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await one(sql`${RUN} where r.id = ${id}`, tx);
    return r ? toRun(r) : null;
  };
  const getTree = async (rootId: string, tx?: Exec) => (await rows(sql`${RUN} where r.root_run_id = ${rootId} order by r.started_at, r.id`, tx)).map(toRun);
  const monthSpend = (where: SQL, tx: Exec) => one(sql`select ${SPENT} as usd from revbound_ledger.actions where ${where}
    and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`, tx).then((r) => Number(r.usd));
  const refuse = async (tx: Exec, base: { id: string; workflow: string; trigger: string; preview: boolean; hash: string; parent?: string | null; root?: string }, reason: string): Promise<Admission> => {
    await tx.execute(sql`insert into revbound_ledger.runs (id, workflow, trigger, preview, input_hash, parent_run_id, root_run_id, status, reason, finished_at)
      values (${base.id}, ${base.workflow}, ${base.trigger}, ${base.preview}, ${base.hash}, ${base.parent ?? null}, ${base.root ?? base.id}, 'refused', ${redact(ctx, reason)}, now())`);
    return { ok: false, reason, runId: base.id };
  };
  /** A preview counts as completed when its root completed and nothing in its tree is still admitted or running. */
  const completedPreview = async (workflow: string, hash: string, hours: number, tx: Exec) => one(sql`select p.id from revbound_ledger.runs p
    where p.workflow = ${workflow} and p.input_hash = ${hash} and p.preview and p.parent_run_id is null and p.status = 'completed'
      and p.started_at >= now() - make_interval(hours => ${hours})
      and not exists (select 1 from revbound_ledger.runs c where c.root_run_id = p.id and c.status in ('admitted', 'running'))
    order by p.started_at desc limit 1`, tx);

  const slot: LedgerSlotV1 = {
    limitsFor,
    getRun: (id) => getRun(id),
    getTree: (rootId) => getTree(rootId),

    async admit(request) {
      const id = randomUUID(), hash = inputHash(request.input), workflow = request.workflow;
      try {
        const limits = await limitsFor(workflow);
        // Before the lock: copy final statuses of the latest preview's tree from the SDK.
        if (request.approve && !request.parent) {
          const latest = await one(sql`select id from revbound_ledger.runs where workflow = ${workflow} and input_hash = ${hash} and preview
            and parent_run_id is null order by started_at desc limit 1`);
          if (latest) for (const r of await getTree(latest.id)) if (!FINAL.includes(r.status)) await slot.refreshRun(r.id);
        }
        return await db().transaction(async (tx) => {
          await tx.execute(LOCK);
          let preview = request.preview === true, approved: number | null = null, note: string | null = null, byPreview: string | null = null;
          let parent: LedgerRun | null = null, root: LedgerRun | null = null;
          const base = { id, workflow, trigger: request.parent ? "child" : request.trigger, preview, hash };
          const cap = request.approve?.maxUsd;
          if (cap !== undefined && !(cap >= 0.01 && Math.round(cap * 100) / 100 === cap)) return refuse(tx, base, `An approval is in whole cents, $0.01 or more, not $${cap}.`);
          if (request.parent) {
            parent = await getRun(request.parent.runId, tx);
            if (!parent) return refuse(tx, base, `fanOut: the parent run ${request.parent.runId} is not in the ledger.`);
            const existing = await one(sql`select id, sdk_run_id, workflow, input_hash, status from revbound_ledger.runs where child_key = ${request.parent.childKey}`, tx);
            if (existing && (existing.workflow !== workflow || existing.input_hash !== hash)) return refuse(tx, base, `fanOut: the child key ${request.parent.childKey} already started another child.`);
            if (existing?.status === "start_failed" && existing.sdk_run_id == null) {
              // Its start failed: a retry starts the same child again.
              await tx.execute(sql`update revbound_ledger.runs set status = 'admitted', reason = null, finished_at = null, started_at = now() where id = ${existing.id}`);
              const top = parent.rootRunId === parent.id ? parent : await getRun(parent.rootRunId, tx);
              return { ok: true, runId: existing.id, rootId: parent.rootRunId, preview: parent.preview, approved: top?.approvedMaxUsd != null };
            }
            if (existing) return { ok: true, runId: existing.id, rootId: parent.rootRunId, preview: parent.preview, approved: false, existing: existing.sdk_run_id ?? existing.id };
            root = parent.rootRunId === parent.id ? parent : await getRun(parent.rootRunId, tx);
            preview = Boolean(root?.preview);
            Object.assign(base, { preview, parent: parent.id, root: parent.rootRunId });
            const treeLimits = await limitsFor(root?.workflow ?? workflow);
            if (limits.approval.required && root?.approvedMaxUsd == null && !preview) return refuse(tx, base, NEEDS_YES);
            if (preview) {
              const children = Number((await one(sql`select count(*) as n from revbound_ledger.runs where root_run_id = ${parent.rootRunId} and parent_run_id is not null and status <> 'refused'`, tx)).n);
              if (children >= treeLimits.approval.previewItems) return refuse(tx, base, `A preview starts at most ${treeLimits.approval.previewItems} children. Size previews with currentRun().preview.`);
            }
          } else if (limits.approval.required && !preview) {
            if (request.trigger === "cron") {
              const s = limits.schedule, today = new Date().toISOString().slice(0, 10);
              if (!s || !(s.approvedUntil.slice(0, 10) >= today)) return refuse(tx, base, `${NEEDS_YES} This schedule's approval ${s ? `ended on ${s.approvedUntil}` : "is missing"}: renew schedule.approvedUntil in workflows/index.ts after a yes.`);
              approved = limits.perRunUsd;
              note = `schedule until ${s.approvedUntil}: ${s.note}`;
            } else if (request.approve && (request.trigger === "cli" || request.trigger === "http")) {
              const p = await completedPreview(workflow, hash, limits.approval.previewWithinHours, tx);
              if (!p) return refuse(tx, base, `${NEEDS_YES} No completed preview of this exact input in the last ${limits.approval.previewWithinHours} hours: run --preview first.`);
              approved = request.approve.maxUsd; note = request.approve.note ?? null; byPreview = p.id;
            } else return refuse(tx, base, NEEDS_YES);
          } else if (request.approve && !preview) {
            approved = request.approve.maxUsd; note = request.approve.note ?? null;
          }
          // Month caps: this month's spend (UTC), open reservations included, must be below each cap.
          const wf = await monthSpend(sql`workflow = ${workflow}`, tx), all = await monthSpend(sql`true`, tx);
          if (wf >= limits.perMonthUsd) return refuse(tx, base, `${workflow} has spent $${wf.toFixed(2)} of its $${limits.perMonthUsd} this month.`);
          if (all >= limits.projectMonthUsd) return refuse(tx, base, `The project has spent $${all.toFixed(2)} of its $${limits.projectMonthUsd} this month.`);
          const rootId = parent ? parent.rootRunId : id;
          await tx.execute(sql`insert into revbound_ledger.runs (id, workflow, trigger, preview, input_hash, approved_max_usd, approval_note, approved_by_preview,
              parent_run_id, root_run_id, child_key, status)
            values (${id}, ${workflow}, ${base.trigger}, ${preview}, ${hash}, ${approved}, ${note}, ${byPreview}, ${parent?.id ?? null}, ${rootId},
              ${request.parent?.childKey ?? null}, 'admitted')`);
          return { ok: true, runId: id, rootId, preview, approved: parent ? root?.approvedMaxUsd != null : approved != null };
        });
      } catch (error) {
        return { ok: false, reason: `The ledger could not admit this run: ${redact(ctx, (error as Error).message)}` };
      }
    },

    async started(runId, sdkId) {
      await db().execute(sql`update revbound_ledger.runs set sdk_run_id = ${sdkId}, status = case when status = 'admitted' then 'running' else status end
        where id = ${runId} and (sdk_run_id is null or sdk_run_id = ${sdkId})`);
    },

    async startFailed(runId, error) {
      const reason = redact(ctx, `The run did not start: ${error instanceof Error ? error.message : String(error)}`);
      await db().execute(sql`update revbound_ledger.runs set status = 'start_failed', reason = ${reason}, finished_at = now() where id = ${runId} and status = 'admitted'`);
    },

    async refreshRun(runId) {
      const row = await getRun(runId);
      const w = workflows();
      if (!row || !row.sdkRunId || FINAL.includes(row.status) || !w) return row;
      const sdk = await w.getRun(row.sdkRunId, { values: true }).catch(() => undefined);
      if (sdk === undefined) return row; // the SDK could not be asked; try again later
      if (sdk === null) {
        await db().execute(sql`update revbound_ledger.runs set status = 'unknown', reason = 'The Workflow SDK no longer has this run.', finished_at = now()
          where id = ${runId} and status in ('admitted', 'running')`);
      } else if (SDK_STATUS[sdk.status] !== "running") {
        const reason = sdk.status === "failed" ? redact(ctx, sdk.error ?? "failed") : null;
        await db().execute(sql`update revbound_ledger.runs set status = ${SDK_STATUS[sdk.status]}, reason = coalesce(${reason}, reason),
          finished_at = coalesce(${sdk.completedAt}::timestamptz, now()) where id = ${runId} and status in ('admitted', 'running')`);
      }
      return getRun(runId);
    },

    async reserve(action) {
      try {
        // Before the lock: the run Revbound admitted for this SDK run, else the Revbound id its attributes claim.
        let row = await one(sql`select id from revbound_ledger.runs where sdk_run_id = ${action.sdkRunId}`);
        const sdk = row ? null : await workflows()?.getRun(action.sdkRunId).catch(() => null);
        const claimed = sdk?.attributes?.revbound_run_id;
        return await db().transaction(async (tx): Promise<Reservation> => {
          await tx.execute(LOCK);
          if (!row && claimed && /^[0-9a-f-]{36}$/i.test(claimed)) {
            const c = await one(sql`select id, sdk_run_id from revbound_ledger.runs where id = ${claimed}`, tx);
            if (c && c.sdk_run_id == null) {
              await tx.execute(sql`update revbound_ledger.runs set sdk_run_id = ${action.sdkRunId}, status = case when status = 'admitted' then 'running' else status end where id = ${claimed}`);
              row = c;
            }
          }
          if (!row) {
            // No Revbound metadata, or it belongs to another SDK run (a re-run that copied attributes): its own external root.
            const ext = randomUUID();
            await tx.execute(sql`insert into revbound_ledger.runs (id, sdk_run_id, workflow, trigger, root_run_id, status)
              values (${ext}, ${action.sdkRunId}, ${sdk?.workflow ?? "unknown"}, 'external', ${ext}, 'running') on conflict (sdk_run_id) do nothing`);
            row = await one(sql`select id from revbound_ledger.runs where sdk_run_id = ${action.sdkRunId}`, tx);
          }
          const run = (await getRun(row!.id, tx))!, root = run.rootRunId === run.id ? run : (await getRun(run.rootRunId, tx))!;
          const est = action.estimateUsd;
          const block = async (reason: string): Promise<Reservation> => {
            // A refusal keeps no idempotency key, so it never stands in for the key's real attempts.
            const b = await one(sql`insert into revbound_ledger.actions (run_id, root_run_id, workflow, plugin, kind, target, keys, outcome, detail)
              values (${run.id}, ${root.id}, ${run.workflow}, ${action.plugin}, ${action.kind}, ${action.target ?? null}, ${JSON.stringify(action.keys ?? {})}::jsonb,
                'blocked', ${redactJson(ctx, { ...action.detail, reason, estimateUsd: est, idempotencyKey: action.idempotencyKey })}::jsonb) returning id`, tx);
            return { ok: false, reason, id: String(b.id) };
          };
          const [limits, rootLimits] = [await limitsFor(run.workflow), await limitsFor(root.workflow)];
          if ((limits.approval.required || rootLimits.approval.required) && root.approvedMaxUsd == null && !root.preview) return block(NEEDS_YES);
          // Same-key repeats: after `ok` nothing runs again; a reservation left open by an earlier attempt of the same step
          // (a crash mid-call) runs again against it, never above it; after `failed` the key's next attempt row reserves
          // and counts again. Any other call (another run, another step, or the same attempt at once) never borrows it.
          const key = action.idempotencyKey;
          const last = await one(sql`select id, run_id, outcome, attempt, reserved_usd::float8 as reserved, detail->'holder' as holder from revbound_ledger.actions
            where idempotency_key = ${key} order by attempt desc limit 1`, tx);
          if (last?.outcome === "ok") return { ok: true, id: String(last.id), runId: run.id, rootId: root.id, repeat: "ok" };
          if (last?.outcome === "reserved" || last?.outcome === "unknown") {
            if (last.run_id !== run.id) return block(`The key ${key} is reserved by another run that has not finished; use a key of this run's own.`);
            const held = last.holder as ReserveRequest["holder"] | null, by = action.holder;
            if (!held || !by || held.step !== by.step || !(by.attempt > held.attempt)) return block(`The key ${key} is in use by another call that has not finished; give each call its own key.`);
            if (est != null && est > Number(last.reserved ?? 0)) return block(`The estimate ($${est}) is above this key's open reservation ($${Number(last.reserved ?? 0)}).`);
            await tx.execute(sql`update revbound_ledger.actions set detail = detail || ${JSON.stringify({ holder: by })}::jsonb where id = ${last.id}`);
            return { ok: true, id: String(last.id), runId: run.id, rootId: root.id, repeat: "reserved" };
          }
          const tree = await one(sql`select ${SPENT} as usd, count(*) filter (where outcome <> 'blocked') as calls from revbound_ledger.actions where root_run_id = ${root.id}`, tx);
          const treeUsd = Number(tree.usd);
          if (root.preview) {
            const a = rootLimits.approval;
            if (Number(tree.calls) + 1 > a.previewCalls) return block(`A preview makes at most ${a.previewCalls} metered or plan calls. Size previews with currentRun().preview.`);
            if (est != null && est > a.previewMaxUsd) return block(`One call's reservation ($${est.toFixed(4)}) is above the preview cap of $${a.previewMaxUsd}; raise approval.previewMaxUsd.`);
            if (est != null && treeUsd + est > a.previewMaxUsd) return block(`The preview would pass its $${a.previewMaxUsd} cap ($${treeUsd.toFixed(4)} spent).`);
          }
          if (est != null) {
            const runUsd = Number((await one(sql`select ${SPENT} as usd from revbound_ledger.actions where run_id = ${run.id}`, tx)).usd);
            if (runUsd + est > limits.perRunUsd) return block(`This run would pass its $${limits.perRunUsd} budget ($${runUsd.toFixed(4)} spent).`);
            if (root.approvedMaxUsd != null && treeUsd + est > root.approvedMaxUsd) return block(`The approved total of $${root.approvedMaxUsd} would be passed ($${treeUsd.toFixed(4)} spent).`);
            const wf = await monthSpend(sql`workflow = ${run.workflow}`, tx), all = await monthSpend(sql`true`, tx);
            if (wf + est > limits.perMonthUsd) return block(`${run.workflow} would pass its $${limits.perMonthUsd} monthly budget ($${wf.toFixed(2)} spent).`);
            if (all + est > limits.projectMonthUsd) return block(`The project would pass its $${limits.projectMonthUsd} monthly budget ($${all.toFixed(2)} spent).`);
          }
          const r = await one(sql`insert into revbound_ledger.actions (run_id, root_run_id, workflow, plugin, kind, target, keys, reserved_usd, outcome, detail, idempotency_key, attempt)
            values (${run.id}, ${root.id}, ${run.workflow}, ${action.plugin}, ${action.kind}, ${action.target ?? null}, ${JSON.stringify(action.keys ?? {})}::jsonb,
              ${est}, 'reserved', ${redactJson(ctx, { ...action.detail, ...(action.holder && { holder: action.holder }) })}::jsonb, ${key}, ${(last?.attempt ?? 0) + 1}) returning id`, tx);
          return { ok: true, id: String(r.id), runId: run.id, rootId: root.id };
        });
      } catch (error) {
        return { ok: false, reason: `The ledger could not check this spend: ${redact(ctx, (error as Error).message)}` };
      }
    },

    async settle(reservationId, actual) {
      try {
        // A cost that is not a number of $0 or more is never recorded: the call's reservation stays what it spent.
        const c = actual.costUsd, cost = typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
        const detail = { ...actual.detail, ...(c != null && cost === null && { invalidCostUsd: String(c) }) };
        await db().execute(sql`update revbound_ledger.actions set cost_usd = coalesce(${cost}::numeric, cost_usd), outcome = ${actual.outcome ?? "ok"},
          detail = detail || ${redactJson(ctx, detail)}::jsonb where id = ${Number(reservationId)} and outcome in ('reserved', 'unknown')`);
      } catch (error) {
        console.error(`[revbound] ledger: could not settle action ${reservationId}; reconcile will (${(error as Error).message})`);
      }
    },

    async reconcile(o = {}) {
      const go = await one(sql`update revbound_ledger.meta set value = now()::text where key = 'reconcile_at'
        and (${o.force === true} or value::timestamptz < now() - interval '60 seconds') returning 1 as ok`);
      if (!go) return { ran: false };
      const w = workflows();
      let linked = 0, external = 0, refreshed = 0;
      if (w) {
        // 1. SDK runs since the cursor (with an overlap): link those Revbound started, record the rest as external.
        const cursor = (await one(sql`select value from revbound_ledger.meta where key = 'reconcile_cursor'`)).value as string;
        const since = cursor === "-infinity" ? cursor : new Date(Date.parse(cursor) - 5 * 60_000).toISOString();
        const runs = await w.listRuns(since);
        for (const r of runs) {
          const known = await one(sql`select id from revbound_ledger.runs where sdk_run_id = ${r.sdkRunId}`);
          if (known) continue;
          const claimed = r.attributes.revbound_run_id;
          const c = claimed && /^[0-9a-f-]{36}$/i.test(claimed) ? await one(sql`select id, sdk_run_id from revbound_ledger.runs where id = ${claimed}`) : undefined;
          if (c && c.sdk_run_id == null) { await slot.started(c.id, r.sdkRunId); linked += 1; continue; }
          const ext = randomUUID(), status = SDK_STATUS[r.status];
          const ins = await rows(sql`insert into revbound_ledger.runs (id, sdk_run_id, workflow, trigger, root_run_id, status, started_at, finished_at)
            values (${ext}, ${r.sdkRunId}, ${r.workflow}, 'external', ${ext}, ${status}, ${r.createdAt}, ${status === "running" ? null : r.completedAt ?? r.createdAt})
            on conflict (sdk_run_id) do nothing returning id`);
          external += ins.length;
        }
        const newest = runs.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), cursor === "-infinity" ? "" : cursor);
        if (newest) await db().execute(sql`update revbound_ledger.meta set value = ${newest} where key = 'reconcile_cursor'`);
        // 2. Statuses of up to 50 running rows, in turn: each pass goes on from where the last one stopped (by id, wrapping).
        const after = (await one(sql`select value from revbound_ledger.meta where key = 'refresh_cursor'`))?.value ?? "";
        const open = sql`select id from revbound_ledger.runs where status = 'running' and sdk_run_id is not null`;
        let turn = await rows(sql`${open} and id::text > ${after} order by id limit 50`);
        if (turn.length < 50) turn = [...turn, ...(await rows(sql`${open} and id::text <= ${after} order by id limit ${50 - turn.length}`))];
        for (const r of turn) {
          await slot.refreshRun(r.id);
          refreshed += 1;
        }
        if (turn.length) await db().execute(sql`insert into revbound_ledger.meta values ('refresh_cursor', ${String(turn.at(-1)!.id)})
          on conflict (key) do update set value = excluded.value`);
      }
      // 3. Admitted rows that never got an SDK run.
      const timedOut = (await rows(sql`update revbound_ledger.runs set status = 'start_failed', reason = 'The run never started (no SDK run after 10 minutes).', finished_at = now()
        where status = 'admitted' and sdk_run_id is null and started_at < now() - interval '10 minutes' returning id`)).length;
      // 4. Reservations on runs that ended stay counted, as unknown.
      const settled = (await rows(sql`update revbound_ledger.actions a set outcome = 'unknown' from revbound_ledger.runs r
        where a.run_id = r.id and a.outcome = 'reserved' and r.status not in ('admitted', 'running') returning a.id`)).length;
      return { ran: true, linked, external, refreshed, timedOut, settled };
    },
  };
  return slot;
}
