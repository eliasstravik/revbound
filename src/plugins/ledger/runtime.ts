/** What `#revbound/ledger` exports: action(), the company-facing helper for paid calls. Workflow-safe: no Node imports. */
import type { Runtime } from "revbound";

export type ActionOptions<T> = {
  /** What it is, e.g. "paid_api". */
  kind: string;
  /** Who it goes to, e.g. the vendor and endpoint. */
  target: string;
  /** The same key never runs twice once it succeeded; pass it on to vendors that accept one. */
  idempotencyKey: string;
  /** The most this call may cost, reserved before it runs. */
  estimateUsd: number;
  /** Natural keys of the person or company the call is about. */
  keys?: { email?: string; domain?: string; linkedin?: string };
  /** The call. `costUsd` is what the vendor charged; it defaults to estimateUsd. */
  run: () => Promise<{ value: T; costUsd?: number }>;
};
export type ActionResult<T> = { status: "done"; value: T } | { status: "done-before" } | { status: "refused"; reason: string };

export type Api = {
  /**
   * A paid call inside a "use step" function: reserved against every budget that applies, run, then settled with its
   * cost. `done-before` means the same key already succeeded (re-read your own tables). A throwing `run` is recorded as
   * failed and rethrown, so the step's retry tries again.
   */
  action<T>(opts: ActionOptions<T>): Promise<ActionResult<T>>;
};

const inWorkflow = () => typeof (globalThis as Record<symbol, unknown>)[Symbol.for("WORKFLOW_USE_STEP")] === "function";

export function bind(rt: Runtime): Api {
  return {
    async action(opts) {
      if (inWorkflow()) throw new Error('action() runs inside a "use step" function, not in workflow code itself.');
      return (await rt.step("action", [opts])) as never;
    },
  };
}
