/** The database plugin's checks: outside builds, the database is reachable and not production's. */
import { join } from "node:path";
import pg from "pg";
import type { CheckResult } from "revbound";
import { type CheckCtx, readJson } from "revbound/cli";
import { assertNotProduction, databaseIdentity, PRODUCTION_DATABASE, value } from "revbound/kit";
import { alive, withDatabase } from "./localdb.js";

export default async function checks(ctx: CheckCtx): Promise<CheckResult[]> {
  if (ctx.build) return [];
  const out: CheckResult[] = [], local = !value("DATABASE_URL");
  try {
    const url = await withDatabase(ctx.dir, async (u) => {
      const client = new pg.Client({ connectionString: u });
      await client.connect();
      await assertNotProduction(async (sql) => (await client.query(sql)).rows, u).finally(() => client.end());
      return u;
    });
    out.push({ level: "info", message: `Database: ${databaseIdentity(url)}${local ? " (local PGlite in .gtm/)" : ""}` });
    if (!local) return out;
    // The URL is stable only when `revbound dev` serves it; a short-lived server's lock is gone by now.
    const lock = readJson(join(ctx.dir, ".gtm", "db.lock"));
    const live = lock?.dev && lock.port === Number(new URL(url).port) && typeof lock.pid === "number" && alive(lock.pid);
    out.push({ level: "info", message: live ? `DATABASE_URL: ${url} (served by \`revbound dev\` while it runs)` : "DATABASE_URL: the local database has a URL only while `npm run dev` runs; run check again then to print it" });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (message.includes(PRODUCTION_DATABASE)) out.push({ level: "error", message: "The database is stamped as production's.", fix: "point DATABASE_URL at a dev branch (`npx revbound docs data`)" });
    else out.push({ level: "error", message: `The database is unreachable: ${message}`, fix: local ? "see `npx revbound docs local`" : "check DATABASE_URL in your env files" });
  }
  return out;
}
