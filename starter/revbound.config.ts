// The project's plugins. Delete a line to remove a default plugin, then run `npx revbound sync`; `npx revbound check` says
// when another plugin needs it. `npx revbound docs plugins` explains the rest.
import { defineRevbound } from "revbound";
import { database } from "revbound/database";
import { ledger } from "revbound/ledger";
import { workflows } from "revbound/workflows";
import { ai } from "revbound/ai";
import { context } from "revbound/context";
import { connections } from "revbound/connections";
import { console } from "revbound/console"; // shadows the global console in this file only
import { agent } from "revbound/agent";

export default defineRevbound({
  company: "Company",
  plugins: [
    database(),
    ledger({ budgets: { perRunUsd: 25, perWorkflowMonthUsd: 300, projectMonthUsd: 1000 } }),
    workflows({ registry: "./workflows", webhooks: "./webhooks" }),
    ai(),
    context(),
    connections(),
    console(),
    agent(),
  ],
  // acknowledge: { customLedger: true, destructive: ["company:0012"] },  // only when needed (`npx revbound docs ledger`)
});
