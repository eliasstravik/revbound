/** The workflows plugin's steps, reached only from the generated binding's "use step" functions. */
import { FatalError, getStepMetadata } from "workflow";
import type { Manifest, SlotMap } from "revbound";
import { context } from "revbound/kit";

export async function run(manifest: Manifest, map: SlotMap, op: string, args: unknown[]): Promise<unknown> {
  const ctx = context(manifest, map), workflows = ctx.get("workflows");
  if (op === "currentRun") return workflows.currentRun();
  if (op === "fanOutBatch") {
    const [parent, child, items, offset] = args as [string, string, unknown[], number];
    // The step id is the same on every retry of this batch and differs between batches and fanOut calls, so a retry
    // finds the children it already started and a second fanOut() never reuses the first one's.
    const ids: string[] = [], { stepId } = getStepMetadata();
    for (const [i, item] of items.entries()) {
      const r = await workflows.start(child, item, { trigger: "child", parent: { runId: parent, childKey: `${parent}:${stepId}:${i}` } });
      if (!r.ok) throw new FatalError(`fanOut: child ${offset + i} of ${child} was refused: ${r.reason}`);
      ids.push(r.runId);
    }
    return ids;
  }
  throw new Error(`The workflows plugin has no step "${op}".`);
}
