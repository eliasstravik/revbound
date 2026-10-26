/** The `workflows` slot (WorkflowsSlotV1): the single start path through the ledger, and the SDK's runs. */
import { getWorkflowMetadata } from "workflow";
import { start as sdkStart } from "workflow/api";
import type { Admission, Ctx, CurrentRun, Registry, WorkflowsSlotV1 } from "revbound";
import { aboutOf, runOf, sdkRun, sdkRuns } from "./sdk.js";

/** Run attributes Revbound puts on every run it starts. */
export const ATTR = { run: "revbound_run_id", root: "revbound_root_id", trigger: "revbound_trigger", preview: "revbound_preview", approved: "revbound_approved" } as const;

export default function provide(ctx: Ctx): WorkflowsSlotV1 {
  const registry = () => ctx.module<Registry>("registry");
  const slot: WorkflowsSlotV1 = {
    async start(name, input, meta): Promise<Admission & { sdkRunId?: string }> {
      const workflows = await registry();
      const fn = Object.hasOwn(workflows, name) ? runOf(workflows[name]) : undefined;
      if (typeof fn !== "function") return { ok: false, reason: `No workflow named "${name}" in workflows/index.ts.` };
      const ledger = ctx.get("ledger");
      const a = await ledger.admit({ workflow: name, input, ...meta });
      if (!a.ok) return a;
      if (a.existing) return { ...a, sdkRunId: a.existing };
      const attributes = { [ATTR.run]: a.runId, [ATTR.root]: a.rootId, [ATTR.trigger]: meta.trigger, [ATTR.preview]: a.preview ? "1" : "0", [ATTR.approved]: a.approved ? "1" : "0" };
      let sdkRunId: string;
      try {
        sdkRunId = (await sdkStart(fn, input === undefined ? [] : [input], { attributes } as never)).runId;
      } catch (error) {
        await ledger.startFailed(a.runId, error);
        throw error;
      }
      await ledger.started(a.runId, sdkRunId);
      return { ...a, sdkRunId };
    },
    async getRun(sdkId, opts) {
      return sdkRun(await registry(), sdkId, opts?.values);
    },
    async listRuns(since) {
      return sdkRuns(await registry(), since);
    },
    async currentRun(): Promise<CurrentRun> {
      const { workflowRunId } = getWorkflowMetadata();
      const sdk = await slot.getRun(workflowRunId), ledger = ctx.get("ledger");
      const id = sdk?.attributes[ATTR.run], row = id ? await ledger.getRun(id) : null;
      const workflow = sdk?.workflow ?? "";
      // A row linked to another SDK run means this one copied its attributes (a re-run): it is external.
      if (!row || (row.sdkRunId && row.sdkRunId !== workflowRunId)) {
        return { id: "", rootId: "", trigger: "external", preview: false, approved: false, workflow, sdkRunId: workflowRunId, previewItems: 0 };
      }
      const root = row.rootRunId === row.id ? row : await ledger.getRun(row.rootRunId);
      const limits = await ledger.limitsFor(root?.workflow ?? row.workflow);
      return { id: row.id, rootId: row.rootRunId, trigger: row.trigger, preview: row.preview, approved: root?.approvedMaxUsd != null,
        workflow: row.workflow, sdkRunId: workflowRunId, previewItems: limits.approval.previewItems };
    },
    async registry() {
      return Object.fromEntries(Object.entries(await registry()).map(([n, e]) => [n, aboutOf(e)]));
    },
  };
  return slot;
}
