/**
 * What `#revbound/workflows` exports: fanOut(), webhook() and currentRun(). Workflow-safe: no Node imports; everything that
 * reads the World or the ledger runs in this plugin's steps (step.ts).
 */
import { FatalError } from "workflow";
import type { CurrentRun, Runtime } from "revbound";
import { brand } from "revbound/kit/brand";

/** What a webhook's onEvent gets: the parsed body, the request, and `start` for a registered workflow (never one that needs approval). */
export type WebhookEvent<B> = { body: B; req: Request; start: (workflow: string, input?: unknown) => Promise<{ runId: string }> };
export type Webhook<B = unknown> = {
  /** Checks the sender's signature on the raw body; false answers 401. */
  verify: (req: Request, raw: string) => boolean | Promise<boolean>;
  /** The sender's event id: a repeat delivery of it is answered 200 without calling onEvent. */
  dedupe: (req: Request, body: B) => string | Promise<string>;
  /** Records a row or starts a workflow. Return "ignored" for events it does not handle. */
  onEvent: (event: WebhookEvent<B>) => Promise<void | "ignored" | { runId: string }>;
};
/** What `webhooks/index.ts` exports as `webhooks`: name → webhook(). */
export type Webhooks = Record<string, Webhook<any>>;

export type FanOutOptions = { batchSize?: number };

export type Api = {
  /**
   * Workflow scope: starts `child` (a registry name) once per item, one step per batch, and returns the child run ids
   * without waiting. In a preview only the first `previewItems` items run. A retried batch skips children already started.
   */
  fanOut<T>(items: T[], child: string, opts?: FanOutOptions): Promise<string[]>;
  /** A branded inbound webhook for webhooks/index.ts. */
  webhook<B = unknown>(hook: Webhook<B>): Webhook<B>;
  /** This run as Revbound knows it: its id, root, trigger, preview and approval. */
  currentRun(): Promise<CurrentRun>;
};

export function bind(rt: Runtime): Api {
  return {
    async fanOut(items, child, opts = {}) {
      const batch = Math.max(1, Math.floor(opts.batchSize ?? 20));
      const run = (await rt.step("currentRun", [])) as CurrentRun;
      if (!run.id) throw new FatalError("fanOut() needs a run started through Revbound (revbound run, a cron, a webhook or fanOut), not a re-run or an outside start.");
      const list = run.preview ? items.slice(0, run.previewItems) : items, ids: string[] = [];
      for (let i = 0; i < list.length; i += batch) ids.push(...((await rt.step("fanOutBatch", [run.id, child, list.slice(i, i + batch), i])) as string[]));
      return ids;
    },
    webhook: (hook) => brand({ ...hook }),
    currentRun: async () => (await rt.step("currentRun", [])) as CurrentRun,
  };
}
