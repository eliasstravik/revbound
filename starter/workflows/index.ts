// The workflow registry: { <name>: workflowFn } or { <name>: { run, description, tables, connections, diagram, approval,
// budget, schedule } }. The console, `revbound run` and crons find workflows only here (`npx revbound docs workflows`).
import type { Registry } from "revbound";

export const workflows = {} satisfies Registry;
