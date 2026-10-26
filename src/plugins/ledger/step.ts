/** The ledger's step side: action() inside a company step (it runs there inline, so its callback never crosses a step). */
import { getStepMetadata, getWorkflowMetadata } from "workflow";
import type { Manifest, SlotMap } from "revbound";
import { context } from "revbound/kit";
import type { ActionOptions, ActionResult } from "./runtime.js";

export async function run(manifest: Manifest, map: SlotMap, op: string, args: unknown[]): Promise<unknown> {
  if (op !== "action") throw new Error(`The ledger plugin has no step "${op}".`);
  const o = args[0] as ActionOptions<unknown>;
  let sdkRunId: string, holder: { step: string; attempt: number };
  try { const s = getStepMetadata(); holder = { step: s.stepId, attempt: s.attempt }; sdkRunId = getWorkflowMetadata().workflowRunId; }
  catch { throw new Error('action() runs inside a "use step" function of a workflow.'); }
  if (!(o.estimateUsd >= 0) || typeof o.run !== "function" || !o.idempotencyKey) throw new Error("action() needs kind, target, idempotencyKey, estimateUsd and run.");
  const ledger = context(manifest, map).get("ledger");
  const r = await ledger.reserve({ sdkRunId, plugin: "company", kind: o.kind, target: o.target, idempotencyKey: o.idempotencyKey, estimateUsd: o.estimateUsd, keys: o.keys, holder });
  if (!r.ok) return { status: "refused", reason: r.reason } satisfies ActionResult<unknown>;
  if (r.repeat === "ok") return { status: "done-before" } satisfies ActionResult<unknown>;
  let result: { value: unknown; costUsd?: number };
  try {
    result = await o.run();
  } catch (error) {
    await ledger.settle(r.id, { outcome: "failed", detail: { error: String((error as Error)?.message ?? error).slice(0, 300) } });
    throw error;
  }
  await ledger.settle(r.id, { costUsd: result?.costUsd ?? o.estimateUsd, outcome: "ok" });
  return { status: "done", value: result?.value } satisfies ActionResult<unknown>;
}
