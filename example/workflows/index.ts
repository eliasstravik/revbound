// The workflow registry: { <name>: workflowFn } or { <name>: { run, description, tables, connections, diagram, approval,
// budget, schedule } }. The console, `revbound run` and crons find workflows only here (`npx revbound docs workflows`).
import type { Registry } from "revbound";
import { exampleImport } from "./example-import";

export const workflows = {
  // An example from `revbound init --example`; see workflows/example-import.ts to remove it.
  "example-import": {
    run: exampleImport,
    description: "Example: saves a list of companies, one row per domain, so they show in Data.",
    tables: ["example_companies"],
    diagram: {
      nodes: [
        { id: "in", label: "Company names and domains", kind: "input", explanation: "The list given to the run, or three samples." },
        { id: "save", label: "Save each company", kind: "output", explanation: "One row per domain in example_companies." },
      ],
      edges: [{ source: "in", target: "save" }],
    },
  },
} satisfies Registry;
