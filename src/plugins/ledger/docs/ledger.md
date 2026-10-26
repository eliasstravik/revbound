# Ledger

The ledger is the company's lasting record in its own Postgres (schema `gtm_ledger`): every run Revbound starts or refuses,
every metered action and its cost, and every approval. Console: **Runs** (status, cost, approval) and, in Data, the
`runs` and `actions` tables and the `run_costs` and `spend_by_workflow_month` views.

## A yes is a record, not a lock

A workflow with `approval: { required: true }` in its registry entry spends nothing unless its root run carries a
recorded approval:

1. **Preview**: `npx revbound run <workflow> --input … --preview`. No approval needed. Tree-wide limits on every backend:
   `previewItems` children (default 3; `fanOut` cuts its list first), `previewCalls` calls (default 10), `previewMaxUsd`
   dollars (default 1). It waits for the whole tree and prints the root's value, each child's value and the total cost.
2. **Ask**: show the sample and the cost in chat and ask Yes/No with the question tool, naming the workflow, the input
   and the cost cap.
3. **Run**: after a yes, `npx revbound run <workflow> --input … --approve --max-usd <n> [--note …] [--prod]` (`<n>` in whole
   cents, $0.01 or more). Accepted only
   when a completed preview of the same input (its root completed, no child still going) exists from the last
   `previewWithinHours` (default 24). The approval records the cap, the note and the preview it rests on.
4. **Schedules**: quote cost per run × runs per month, ask, then commit `schedule: { approvedUntil: "2026-12-31",
   note: "weekly, about $4 a run" }` next to `budget: { perRunUsd, perMonthUsd }`, in the same change that adds the
   cron to `vercel.json`. The approval is reviewed and deployed through git. A cron start after `approvedUntil` is
   refused; `revbound check` warns two weeks ahead.

Without a yes, a start answers 403: "This workflow needs a person's yes. Run a preview, show the person the sample and
the cost, and ask Yes/No in chat. Only after a yes, run it again with `--approve --max-usd`."

Webhooks can never start an approval-required workflow. Children inherit their root's preview and approval; an
approval-required child of an unapproved root is refused. A re-run started from the run inspector or Vercel's
dashboard is its own unapproved root, even when it copies the original's attributes.

**What this is not.** The agent can approve on its own: it holds the automation secret and edits the registry.
Approvals are a seatbelt and a receipt until Revbound can verify who a reviewer is. Ask the person every time.

## Budgets

Every metered call reserves its estimate before it runs, under one project-wide lock, and is refused if it would pass:

- the run's own budget: `budget.perRunUsd`, else `ledger({ budgets: { perRunUsd } })` (default $25), children included;
- the root's approved total (`--max-usd`, or `budget.perRunUsd` for a schedule);
- the workflow's month (UTC): `budget.perMonthUsd`, else `perWorkflowMonthUsd` (default $300);
- the project's month: `projectMonthUsd` (default $1,000).

After the call it settles at its real cost. Only two things can pass a cap: the gap between estimate and actual on
calls already in flight, and a vendor charging twice for a paid call retried after a crash mid-call. Model calls pass
`maxOutputTokens` (default 4,096) to the model, so their estimate is a real ceiling. Local `claude`/`codex` calls cost
no dollars: they are counted (previews still stop at `previewCalls`) and show "plan usage, not metered".

Hosted, set AI Gateway's own budgets in the Vercel dashboard as the outer ceiling.

## Paid calls outside agent(): action()

```ts
import { action } from "#gtm/ledger";

async function enrich(domain: string) {
  "use step";
  const r = await action({
    kind: "paid_api", target: "vendor: /v1/enrich", idempotencyKey: `enrich:${domain}`, estimateUsd: 0.05,
    keys: { domain },
    run: async () => { const data = await callVendor(domain, { idempotencyKey: `enrich:${domain}` }); return { value: data, costUsd: 0.04 }; },
  });
  if (r.status === "refused") throw new FatalError(r.reason);
  if (r.status === "done-before") return readFromOwnTable(domain);
  return r.value;
}
```

- Inside a `"use step"` body only. `done-before`: the same key already succeeded; re-read your own tables.
- A throwing `run` is recorded as failed (its reservation stays counted) and rethrown, so the step's retry tries
  again with a new attempt row. A row still reserved after a crash mid-call runs again against its reservation on the
  step's retry, and the vendor may charge twice: pass `idempotencyKey` on to vendors that accept one.
- One key, one call at a time: a second call with a key that is still reserved (in parallel, or from another step) is
  `refused`. Give each item its own key, e.g. `enrich:${domain}`.
- `costUsd` defaults to `estimateUsd` when the vendor reports nothing.

## Failure modes and freshness

- Admit and reserve fail closed: any error refuses. A settle error is logged; the row stays reserved, still counted,
  and reconcile settles it.
- Reconcile keeps the record complete with one writer: it links SDK runs Revbound started, records runs started elsewhere
  as `external`, copies final statuses, marks runs whose SDK record is gone `unknown`, fails starts that never
  happened after 10 minutes, and settles reservations of ended runs as `unknown`. It runs at most once a minute: after
  each Runs read, hourly through `/api/gtm/ledger/reconcile` (`vercel.json`, needs `CRON_SECRET`), and every minute
  under `revbound dev`. `revbound run` refreshes the run it waits on, so watched runs are current within seconds.

## A custom ledger

The ledger decides what runs and what it may spend, so `revbound check` fails while the ledger slot is anything but the
package's own `ledger()`: an ejected copy, an edited object or another plugin. Set `acknowledge: { customLedger: true }`
in gtm.config.ts to accept it; `revbound check --prod` prints the acknowledgment. A custom ledger stops getting the
package's safety fixes.

## Natural keys and deleting them

Ledger rows hold no secrets and no run inputs (an input hash only). Action rows carry the natural keys of the people
and companies they were about (`keys`: `email`, `domain`, `linkedin`). To delete a person's keys:

```sql
update gtm_ledger.actions set keys = keys - 'email' - 'linkedin' where keys->>'email' = 'person@example.com';
```
