/**
 * The agent's own tools beside eve's defaults: starting and reading runs through the app (so the ledger admits every
 * start), and git__gh, eve's GitHub tool held to pull-request branches.
 */
import { defineGhTool, githubShellApproval } from "eve/extensions/git/sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { appApi } from "../app.js";
import { githubCommand, requesterOnly, runApproval } from "../approval.js";
import { github } from "./git.js";

/** Models sometimes send an object as JSON text. */
const asObject = (v: unknown) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

const money = (n: number) => `$${n.toFixed(2)}`;

type Who = { authenticator: string; principalId: string } | null | undefined;
/** How the ledger's approval note names the person who said yes. */
export const yesNote = (who: Who) => `Yes in chat from ${who ? who.principalId : "an unknown person"}`;

const startInput = z.object({
  workflow: z.string().regex(/^[A-Za-z0-9_-]+$/u).describe("A workflow name from workflows/index.ts."),
  input: z.preprocess(asObject, z.record(z.string(), z.unknown())).optional().describe('The run\'s input as a JSON object, e.g. {"limit": 5}; omit for none.'),
  preview: z.boolean().describe("true for a preview (no yes needed, capped by the ledger); false for the real run."),
  maxUsd: z.number().positive().optional().describe("Real runs only: the most the run may spend, in dollars, as you quoted it."),
  summary: z.string().min(1).describe("One line for the person: what the run does, how many rows, the cost quote."),
});

export const startRun = defineTool({
  description: "Start a run of a registered workflow through the ledger. A real run (and on a laptop, a preview too) first asks the person who asked you for a yes, " +
    "showing `summary` and `maxUsd`. Returns { runId }; read the result with run_status.",
  inputSchema: startInput,
  approval: {
    request: runApproval,
    response: requesterOnly,
    prompt: ({ input }) => (input.preview ? `Preview ${input.workflow}? ${input.summary}` : `Run ${input.workflow}, spending at most ${money(input.maxUsd ?? 0)}? ${input.summary}`),
  },
  label: { start: ({ workflow, preview }) => `${preview ? "Preview" : "Start"} ${workflow}` },
  async execute({ workflow, input, preview, maxUsd }, ctx) {
    if (!preview && !(maxUsd! > 0)) throw new Error("A real run needs maxUsd, the most it may spend, as you quoted it to the person.");
    const body = {
      ...(input !== undefined && { input: asObject(input) }),
      ...(preview ? { preview: true } : { approve: { maxUsd, note: yesNote(ctx.approval?.responder ?? ctx.session.auth.current) } }),
    };
    return appApi(`/start/${encodeURIComponent(workflow)}`, { method: "POST", body: JSON.stringify(body) });
  },
});

export const runStatus = defineTool({
  description: "Read a run and, for a preview, its whole tree: { run: { status, returnValue, error }, tree, final, costUsd }. " +
    "Waits up to 60 seconds while it is still going; call again if `final` is false.",
  inputSchema: z.object({ runId: z.string().regex(/^[0-9a-f-]{36}$/iu) }),
  label: { start: () => "Check the run" },
  async execute({ runId }) {
    const until = Date.now() + 60_000;
    for (;;) {
      const state = await appApi(`/runs/${encodeURIComponent(runId)}?tree=1`);
      if (state.final || Date.now() > until) return state;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  },
});

const gh = defineGhTool(github);

/** eve's git__gh, held to pull-request branches (approval.ts: githubCommand). */
export const ghTool = defineTool({
  ...gh,
  approval: {
    request: ({ toolInput }) => {
      const checked = githubShellApproval(toolInput as never);
      if (checked !== "not-applicable") return checked;
      return githubCommand(String((toolInput as { command?: string } | undefined)?.command ?? ""));
    },
  },
});
