import { definePlugin } from "revbound";

export type { ActionOptions, ActionResult } from "./runtime.js";

const P = "revbound/ledger";
const SRC = "revbound/src/plugins/ledger";

type Budgets = { perRunUsd?: number; perWorkflowMonthUsd?: number; projectMonthUsd?: number };

/**
 * The `ledger` slot: the company's lasting record of every run, refused start, cost and approval, and the budgets and
 * approvals every spend is checked against. A custom or ejected ledger needs acknowledge: { customLedger: true }.
 */
export function ledger(opts: { budgets?: Budgets } = {}) {
  return definePlugin({
    name: "ledger",
    api: 1,
    provides: ["ledger"],
    provide: `${P}/provide`,
    needs: ["database"],
    uses: ["workflows"],
    runtime: { from: `${P}/runtime`, step: `${P}/step`, exports: ["action"] },
    migrations: `${SRC}/migrations`,
    options: { budgets: opts.budgets ?? {} },
    tables: [
      { schema: "gtm_ledger", name: "runs", label: "Ledger: runs" },
      { schema: "gtm_ledger", name: "actions", label: "Ledger: actions" },
      { schema: "gtm_ledger", name: "run_costs", label: "Ledger: cost per run" },
      { schema: "gtm_ledger", name: "spend_by_workflow_month", label: "Ledger: spend by workflow and month" },
    ],
    routes: [
      { path: "ledger/reconcile", methods: ["GET"], access: "cron", handler: `${P}/routes#reconcile` },
      { path: "ledger/tick", methods: ["POST"], access: "local", handler: `${P}/routes#tick` },
      { path: "ledger/runs", methods: ["GET"], access: "session", handler: `${P}/routes#runs` },
    ],
    views: [{ path: "runs", title: "Runs", nav: { label: "Runs", order: 25 }, fill: true, component: `${P}/view` }],
    workflowTabs: [{ id: "runs", title: "Runs", order: 20, component: `${P}/view#RunsTab` }],
    agents: `- The ledger records every run, refused start, cost and approval in Postgres (\`gtm_ledger\`). A workflow with
  \`approval: { required: true }\` spends nothing without a recorded yes, and every paid call outside \`agent()\` goes through
  \`action()\` from \`#gtm/ledger\` inside a step. A 403 that says "This workflow needs a person's yes" means: preview, show, ask,
  then \`--approve\`. You can approve on your own, so never do: the person gives every yes in chat (docs: ledger).`,
    docs: { ledger: `${SRC}/docs/ledger.md` },
    dev: `${P}/dev`,
  });
}
