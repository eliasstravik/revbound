/** `#revbound/database` in workflow scope (the `workflow` export condition): no pg, and db() says where it runs. */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Runtime } from "revbound";

export type { NodePgDatabase };
export function db(): NodePgDatabase {
  throw new Error('db() runs inside a "use step" function or a route handler, never in workflow code itself.');
}
export type Api = { db: typeof db };
export const bind = (_rt: Runtime): Api => ({ db });
