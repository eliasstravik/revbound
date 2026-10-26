import { definePlugin } from "revbound";

export type { AgentOptions, AgentResult, AgentTools, McpServer } from "./runtime.js";

const P = "revbound/ai";
const SRC = "revbound/src/plugins/ai";

/**
 * agent(): every AI call in a workflow, on AI Gateway (hosted, or with its key), a provider key, or the person's own
 * signed-in `claude` or `codex` locally. Each metered call is reserved before it runs; previews count every call.
 */
export function ai() {
  return definePlugin({
    name: "ai",
    api: 1,
    needs: ["workflows", "ledger"],
    capabilities: ["spends"],
    runtime: { from: `${P}/runtime`, step: `${P}/step`, exports: ["agent", "tool"] },
    agents: `- Every AI call in a workflow, one-shot or tool-using, is \`agent()\` from \`#gtm/ai\` (no \`tools\` for a one-shot extract or
  score). Never import \`ai\` or \`@ai-sdk/*\` in company code, and never write a model id there: \`GTM_MODEL\` picks the model.
  Size previews with \`currentRun().preview\` from \`#gtm/workflows\`: a preview may make at most a few calls (docs: ai).`,
    docs: { ai: `${SRC}/docs/ai.md` },
  });
}
