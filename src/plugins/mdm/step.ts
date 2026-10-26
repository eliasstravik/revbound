/** The mdm plugin's steps: each `#revbound/mdm` call, with the running workflow and its ledger run stamped on every write. */
import { FatalError, getWorkflowMetadata } from "workflow";
import type { Manifest, SlotMap } from "revbound";
import { context } from "revbound/kit";
import type { WriteOptions } from "./runtime.js";
import type { MdmSlotV1, Origin } from "./types.js";

const WRITES = ["upsertCompany", "upsertPerson", "upsertSignal"];
const OTHERS = ["findCompany", "findPerson", "merge", "known", "stale", "signals"];
const runs = new Map<string, Promise<{ workflow: string; id: string }>>();

export async function run(manifest: Manifest, map: SlotMap, op: string, args: unknown[]): Promise<unknown> {
  const ctx = context(manifest, map), mdm = ctx.get<MdmSlotV1>("mdm");
  try {
    if (WRITES.includes(op)) {
      const [input, opts] = args as [never, WriteOptions | undefined];
      let sdkRunId = "";
      try { sdkRunId = getWorkflowMetadata().workflowRunId; } catch {} // outside a workflow, `source` names it alone
      if (!runs.has(sdkRunId)) {
        if (runs.size > 100) runs.clear();
        const none = { workflow: "", id: "" };
        runs.set(sdkRunId, sdkRunId && ctx.has("workflows") ? ctx.get("workflows").currentRun().catch(() => { runs.delete(sdkRunId); return none; }) : Promise.resolve(none));
      }
      const r = await runs.get(sdkRunId)!;
      const origin: Origin = { source: opts?.source ?? r.workflow, workflow: r.workflow || null, runId: r.id || null };
      return await (mdm[op as "upsertCompany"] as (i: never, o: Origin) => Promise<unknown>)(input, origin);
    }
    if (OTHERS.includes(op)) return await (mdm[op as "known"] as (...a: unknown[]) => Promise<unknown>)(...args);
  } catch (error) {
    // A refused input fails the same way on every retry, so it ends the run at once with the reason.
    if ((error as Error)?.name === "MdmInputError") throw new FatalError((error as Error).message);
    throw error;
  }
  throw new Error(`The mdm plugin has no step "${op}".`);
}
