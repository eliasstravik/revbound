import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Runtime } from "revbound";
import { PRODUCTION_DATABASE, assertNotProduction, isHosted, value } from "revbound/kit";

export type { NodePgDatabase };

/** What `#gtm/database` exports. In workflow scope this module is replaced by runtime-workflow.ts (no pg). */
export type Api = { db: typeof db };
export const bind = (_rt: Runtime): Api => ({ db });

type Call = (...args: unknown[]) => unknown;
const KEY: unique symbol = Symbol.for("revbound/db");

/** A pool that runs the production-stamp check once, before its first query or checkout. */
class GtmPool extends pg.Pool {
  #url: string;
  #checked?: Promise<void>;

  constructor(url: string) {
    super({ connectionString: url, max: isHosted() ? undefined : 3 });
    this.#url = url;
    // An idle client the server dropped (a restart, a pooler timeout) must not crash the process; the next query reconnects.
    this.on("error", (error) => console.error(`revbound db(): an idle database connection closed (${error.message})`));
  }

  #check(): Promise<void> {
    return (this.#checked ??= assertNotProduction((sql) => super.query(sql).then((r) => r.rows), this.#url).catch((error) => {
      // Drizzle wraps query errors as "Failed query: …" (ours is the cause), so say it plainly once per pool.
      if (error?.message === PRODUCTION_DATABASE) console.error(`revbound db(): ${PRODUCTION_DATABASE}`);
      else this.#checked = undefined; // retry after a connection error
      throw error;
    }));
  }

  override query(...args: any[]): any {
    return this.#check().then(() => (super.query as Call).apply(this, args));
  }

  // pg's own query() checks out through connect(callback); only the promise form (transactions) needs the gate.
  override connect(...args: any[]): any {
    if (args.length) return (super.connect as Call).apply(this, args);
    return this.#check().then(() => super.connect());
  }
}

/**
 * The project's Drizzle database over DATABASE_URL: one pool per process (at most 3 connections locally). Call it
 * inside step bodies and route handlers, never at module top level or while `next build` prerenders.
 */
export function db(): NodePgDatabase {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    throw new Error('db() was called during `next build`: pages that read data must be dynamic (export const dynamic = "force-dynamic").');
  }
  const store = globalThis as { [KEY]?: NodePgDatabase };
  if (store[KEY]) return store[KEY];
  const url = value("DATABASE_URL");
  if (!url) {
    throw new Error(isHosted()
      ? "DATABASE_URL is not set in this deployment: connect Neon via the Vercel Marketplace; see `npx revbound docs deploy`."
      : "DATABASE_URL is not set: run the app with `revbound dev` (npm run dev), which serves the local database.");
  }
  return (store[KEY] = drizzle({ client: new GtmPool(url) }));
}
