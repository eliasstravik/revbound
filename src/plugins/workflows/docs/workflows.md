# Workflows

Ready-made workflows (import a list, enrich companies, a weekly scheduled job) are recipes to copy when a person
asks for one: `npx revbound docs recipes`.

## The registry

`workflows/index.ts` exports `workflows = { <name>: workflowFn }` (typed `satisfies Registry`, from `revbound`). The key
is the workflow's name everywhere: `npx revbound run <name>`, `/api/revbound/start/<name>`, `/api/revbound/cron/<name>`,
`fanOut()` and the console. Revbound starts only registered workflows; `npx revbound check` reports a broken registry.
An entry can also be an object:

```ts
export const workflows = {
  "qualify-companies": {
    run: qualifyCompanies,
    description: "Scores each company against our ICPs and keeps the verdict.",
    tables: ["qualified_companies"],
    connections: ["FIRECRAWL_API_KEY"],
    diagram: {
      nodes: [
        { id: "in", label: "Company domains", kind: "input", explanation: "The domains given to the run." },
        { id: "fit", label: "Fits an ICP?", kind: "decision", explanation: "Read the site and compare it with context/icps." },
        { id: "save", label: "Save the verdict", kind: "output", explanation: "One row per domain in qualified_companies." },
      ],
      edges: [{ source: "in", target: "fit" }, { source: "fit", target: "save", label: "Yes" }],
    },
    approval: { required: true },                  // spends nothing without a recorded yes (docs: ledger)
    budget: { perRunUsd: 5, perMonthUsd: 50 },     // caps every run of it, children included, and its month
  },
} satisfies Registry;
```

- `description`, `tables`, `connections` and `diagram` are what the console shows; none changes how it runs.
  `diagram` holds the business steps (`kind`: `input`, `action`, `decision` or `output`; a decision's edges carry
  labels). Write it for the GTM team, not as code, and update it in the same change as the workflow.
- `approval`, `budget` and `schedule` are what the ledger enforces (docs: ledger). Mark every workflow that spends
  money or acts on people as `approval: { required: true }`.

The console's workflow page has a tab per plugin: Diagram, Runs (from the ledger: status, cost, approval), Data
(the `tables`) and Connections (the `connections`, set or missing here).

## Results and runs

- A workflow writes its lasting results to the company's own tables in `public` through `db()` (docs: data).
- The ledger records every run, child and refused start in Postgres (`revbound_ledger.runs`), with costs and approvals,
  long after the Workflow SDK's own run store forgets them. A run's steps, inputs and errors are in the SDK's run
  inspector: **Open in Workflow** locally, **Open in Vercel** hosted.
- Schedules: `vercel.json` crons whose path is `/api/revbound/cron/<name>`. Vercel Cron runs them in production only,
  with `CRON_SECRET`. A cron run gets no input. A schedule of an approval-required workflow also needs its approval
  committed in the registry (docs: ledger). Locally nothing fires on its own; start it with `npx revbound run <name>`.

## Helpers from `#revbound/workflows`

- `fanOut(items, "<child workflow>", { batchSize = 20 })` (workflow scope) starts the child once per item, one step
  per batch, and returns the child run ids without waiting. Children write their results to the company's tables. A
  retried batch skips children already started. In a preview it first cuts `items` to the workflow's
  `approval.previewItems` (default 3).
- `currentRun()` (workflow scope or a step) returns this run as Revbound knows it: `{ id, rootId, trigger, preview,
  approved, workflow, previewItems }`. Size previews with it: process only the first few rows when `preview` is true.
- `webhook({ verify, dedupe, onEvent })` builds an inbound webhook for `webhooks/index.ts` (docs: webhooks).
- Company code never imports `start` from `workflow/api`: every start goes through the ledger.

## Preview, yes in chat, run

Runs never pause for people, and the console has no start or approve buttons. For a risky or costly run:

1. Preview: `npx revbound run <workflow> --input '<json>' --preview`. It needs no approval; its limits apply tree-wide
   (`previewItems` children, `previewCalls` calls, `previewMaxUsd` dollars). It waits for the whole tree, then prints
   the root's return value, each child's return value and the tree's total cost.
2. Show the sample and the cost in this chat and ask Yes/No with the question tool, naming the workflow, the input
   and the cost cap.
3. Only after a yes:
   `npx revbound run <workflow> --input '<json>' --approve --max-usd <n> [--note "<what was approved>"]`. It is accepted
   only when a completed preview of the same input exists from the last `previewWithinHours` (24).

Cost quotes: a local preview on `claude`/`codex` measures plan usage, not dollars ("plan usage, not metered"). Quote a
hosted run as the hosted model's price × the preview's usage, or run a small preview with `--prod`. A schedule's yes
quotes cost per run × runs per month.

## `revbound run`

```sh
npx revbound run <workflow> [--input '<json>'] [--preview] [--approve --max-usd <n> [--note <text>]] [--prod] [--no-wait]
```

- Default: `POST http://127.0.0.1:$REVBOUND_PORT/api/revbound/start/<workflow>`, so `npm run dev` must be running.
- `--prod`: the same on `REVBOUND_PRODUCTION_URL` with the `x-vercel-protection-bypass` header set to
  `REVBOUND_BYPASS_SECRET` (docs: deploy).
- It prints the run's status, return value, error and cost as JSON and exits non-zero unless it completed. A refusal
  prints the ledger's reason (a 403).
- Start and run status answer only on `127.0.0.1`/`localhost` locally, and only with the automation bypass hosted.

## Run size

Keep each run under ~2,000 events (the Workflow SDK caps a run at 25,000 and replay slows past ~2,000): about 20 rows
per run when each row calls `agent()` with tools, about 100 when rows are plain steps. Fan larger lists out with
`fanOut()` into child runs of that size.

## Scope rules

- `db()` (`#revbound/database`) only inside `"use step"` bodies and route handlers; in workflow code itself it throws.
- `agent()` (`#revbound/ai`) only in workflow scope, never inside a `"use step"` body; it makes its own steps (docs:
  ai).
- `action()` (`#revbound/ledger`) only inside a `"use step"` body (docs: ledger).
- `fanOut()` in workflow scope; `currentRun()` anywhere in a run.
