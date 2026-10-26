/** `revbound migrate`: the plugins' migrations in needs order, then the company's db/migrations. */
import { join } from "node:path";
import type { RevboundConfig, MigrationPlan } from "revbound";
import { byNeeds, type CliCtx, filePath, loadEnv, schemaOf } from "revbound/cli";
import { PRODUCTION_DATABASE, environment, isHosted, value } from "revbound/kit";
import { withDatabase, withMigrateLock } from "./localdb.js";
import { applyPlan, stamp } from "./migrate.js";

/** What revbound migrate applies for this project. */
export function migrationPlan(dir: string, config: RevboundConfig): MigrationPlan {
  const sets = byNeeds(config.plugins).flatMap((p) => {
    const folder = p.migrations && filePath(dir, p.migrations);
    return folder ? [{ id: p.name, schema: schemaOf(p), folder }] : [];
  });
  return { sets, company: join(dir, "db", "migrations"), destructive: config.acknowledge?.destructive ?? [] };
}

/** Migrates `url`: locally under .revbound/migrate.lock (PGlite shares one session, so advisory locks never block). */
export async function migrate(dir: string, config: RevboundConfig, url: string): Promise<void> {
  const run = async () => {
    const applied = await applyPlan(migrationPlan(dir, config), url);
    if (environment() === "production") await stamp(url);
    console.log(applied ? `revbound migrate: applied ${applied} migration(s).` : "revbound migrate: the database is up to date.");
  };
  return isHosted() ? run() : withMigrateLock(dir, run);
}

export default async function migrateCommand(args: string[], ctx: CliCtx): Promise<void> {
  if (args.length) throw new Error("Usage: revbound migrate");
  loadEnv(ctx.dir, !isHosted());
  const where = environment(), url = value("DATABASE_URL");
  if (where === "local") return withDatabase(ctx.dir, (u) => migrate(ctx.dir, ctx.config, u));
  if (where === "production") {
    if (!url) throw new Error("DATABASE_URL is not set for Production: connect Neon via the Vercel Marketplace; see `npx revbound docs deploy`.");
    return migrate(ctx.dir, ctx.config, url);
  }
  if (!url) return console.log("revbound migrate: Preview has no DATABASE_URL of its own; skipping migrations.");
  await migrate(ctx.dir, ctx.config, url).catch((error: Error) => {
    if (error.message !== PRODUCTION_DATABASE) throw error;
    console.log("revbound migrate: Preview's DATABASE_URL is production's database; skipping migrations (give Preview its own Neon branch).");
  });
}
