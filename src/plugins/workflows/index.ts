import { definePlugin } from "revbound";

export type { FanOutOptions, Webhook, WebhookEvent, Webhooks } from "./runtime.js";

const P = "revbound/workflows";
const SRC = "revbound/src/plugins/workflows";

/**
 * The `workflows` slot on the Workflow SDK: the registry and webhooks, the single start path through the ledger,
 * fanOut(), webhook(), currentRun(), crons, `revbound run`, the Workflows views and the local run inspector.
 */
export function workflows(opts: { registry?: string; webhooks?: string } = {}) {
  const registry = opts.registry ?? "./workflows", webhooks = opts.webhooks ?? "./webhooks";
  return definePlugin({
    name: "workflows",
    api: 1,
    provides: ["workflows"],
    provide: `${P}/provide`,
    needs: ["database", "ledger"],
    runtime: { from: `${P}/runtime`, step: `${P}/step`, exports: ["fanOut", "webhook", "currentRun"] },
    migrations: `${SRC}/migrations`,
    modules: { registry: `${registry}#workflows`, webhooks: `${webhooks}#webhooks` },
    options: { registry, webhooks },
    routes: [
      { path: "workflows", methods: ["GET"], access: "session", handler: `${P}/routes#list` },
      { path: "start/:name", methods: ["POST"], access: "automation", handler: `${P}/routes#start` },
      { path: "runs/:id", methods: ["GET"], access: "automation", handler: `${P}/routes#status` },
      { path: "cron/:name", methods: ["GET"], access: "cron", handler: `${P}/routes#cron` },
      { path: "hooks/:name", methods: ["POST"], access: "signature", secret: "REVBOUND_HOOK_{name}_BYPASS", handler: `${P}/hooks` },
      { path: "inspector", methods: ["GET", "POST"], access: "local", handler: `${P}/routes#inspector` },
      { path: "inspector/*", methods: ["GET", "POST"], access: "local", handler: `${P}/routes#inspector` },
    ],
    views: [
      { path: "workflows", title: "Workflows", nav: { label: "Workflows", order: 20 }, component: `${P}/views#WorkflowsView` },
      { path: "workflows/:name", title: "Workflow", fill: true, component: `${P}/views#WorkflowView` },
    ],
    workflowTabs: [{ id: "diagram", title: "Diagram", order: 10, component: `${P}/views#DiagramTab` }],
    cli: [{ name: "run", describe: "start a run and print its status, return value and cost (--preview, --approve --max-usd)", run: `${P}/cli` }],
    trace: ["./vercel.json"],
    agents: `- \`workflows/\`: Workflow SDK workflows, each registered by name in \`workflows/index.ts\` with what the console shows and its
  \`approval\`, \`budget\` and \`schedule\` (docs: workflows). Lasting results go in the company's own tables. Start child runs with
  \`fanOut()\` from \`#revbound/workflows\`, never \`start()\`. Ready-made workflows to copy when a person asks: \`npx revbound docs recipes\`.
- \`webhooks/index.ts\`: inbound webhooks built with \`webhook()\` from \`#revbound/workflows\` (docs: webhooks).
- Risky or costly runs: \`npx revbound run <workflow> --input … --preview\` first, show its sample and cost in this chat, ask Yes/No
  with the question tool naming the workflow, the input and the cost cap, and only after a yes run it with
  \`--approve --max-usd <n>\`. A schedule's yes (cost per run × runs per month) is committed as \`schedule: { approvedUntil, note }\`
  next to \`budget\`, in the same change that adds the cron to vercel.json. Runs never wait for people.`,
    docs: { workflows: `${SRC}/docs/workflows.md`, webhooks: `${SRC}/docs/webhooks.md` },
    checks: `${P}/checks`,
    next: `${P}/next`,
  });
}
