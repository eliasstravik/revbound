import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { MigrationPlan } from "revbound";
import { PRODUCTION_DATABASE, assertNotProduction, databaseIdentity, environment, isHosted } from "revbound/kit";

// Matched after removing comments and `ON DELETE` (a foreign-key clause, not a delete).
const DESTRUCTIVE = /\b(DROP|RENAME|TRUNCATE|DELETE)\b|\bALTER\s+(TYPE|COLUMN\s+("[^"]*"|\w+)\s+(SET\s+DATA\s+)?TYPE)\b/i;
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** A plugin's migrations: `NNNN_name.sql` files, in order, as `<plugin>:<NNNN>` ids. */
export function pluginMigrations(plugin: string, folder: string): { id: string; file: string }[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f)).sort().map((f) => ({ id: `${plugin}:${f.slice(0, 4)}`, file: join(folder, f) }));
}

const risky = (sql: string) => DESTRUCTIVE.test(sql.replace(/--.*$/gm, "").replace(/\bON\s+DELETE\b/gi, ""));

/** Refuses pending migrations that may lose data, unless acknowledged by exact id. */
function refuseDestructive(pending: { id: string; sql: string }[], acknowledged: string[]): void {
  const bad = pending.filter((m) => risky(m.sql) && !acknowledged.includes(m.id)).map((m) => m.id);
  if (!bad.length) return;
  throw new Error(`revbound migrate refused on production: ${bad.join(", ")} may lose data (DROP, RENAME, TRUNCATE, ALTER … TYPE or DELETE). ` +
    `After a yes in chat and a Neon backup branch, add ${bad.map((b) => `"${b}"`).join(", ")} to acknowledge.destructive in revbound.config.ts (\`npx revbound docs data\`).`);
}

/**
 * Applies every plugin's migrations in plan order (each set in one transaction holding the migrate lock, bookkept in
 * `<schema>.__revbound_migrations`), then the company's db/migrations with Drizzle. Hosted production refuses unacknowledged
 * destructive migrations first. Returns how many were applied.
 */
export async function applyPlan(plan: MigrationPlan, url: string): Promise<number> {
  const production = environment() === "production";
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let applied = 0;
  try {
    await assertNotProduction(async (sql) => (await client.query(sql)).rows, url);
    for (const set of plan.sets) {
      await client.query("begin");
      try {
        // A transaction-scoped advisory lock also holds through Neon's pooler, where a session lock can stay stuck.
        await client.query("select pg_advisory_xact_lock(hashtext('revbound-migrate'))");
        await client.query(`create schema if not exists ${ident(set.schema)}`);
        await client.query(`create table if not exists ${ident(set.schema)}.__revbound_migrations (id text primary key, applied_at timestamptz not null default now())`);
        const done = new Set((await client.query(`select id from ${ident(set.schema)}.__revbound_migrations`)).rows.map((r) => r.id));
        const pending = pluginMigrations(set.id, set.folder).filter((m) => !done.has(m.id)).map((m) => ({ ...m, sql: readFileSync(m.file, "utf8") }));
        if (production) refuseDestructive(pending, plan.destructive);
        for (const m of pending) {
          await client.query(m.sql);
          await client.query(`insert into ${ident(set.schema)}.__revbound_migrations (id) values ($1)`, [m.id]);
        }
        await client.query("commit");
        applied += pending.length;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
    if (plan.company && existsSync(join(plan.company, "meta", "_journal.json"))) applied += await applyCompany(client, plan.company, production, plan.destructive);
    if (String((await client.query("select version()")).rows[0].version).includes("PGlite")) await client.query(ANALYZE_FILLED);
  } finally {
    await client.end();
  }
  return applied;
}

/** Marks the database as production's: db() and revbound migrate refuse it anywhere else. */
export async function stamp(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("insert into revbound.meta (key, value) values ('production', $1) on conflict (key) do update set value = excluded.value", [databaseIdentity(url)]);
  } finally {
    await client.end();
  }
}

// PGlite has no autovacuum, so the Data view's estimates stay "unknown" until ANALYZE. Empty tables are skipped:
// their 0 would go stale as rows arrive, while "unknown" stays honest.
const ANALYZE_FILLED = `do $$ declare t regclass; filled boolean; begin
  for t in select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('select exists (select 1 from %s)', t) into filled;
    if filled then execute format('analyze %s', t); end if;
  end loop; end $$`;

/**
 * The company's Drizzle migrations inside one transaction holding the migrate lock, which makes Drizzle's read of the
 * last applied entry and its applies atomic. Drizzle's own BEGIN inside ours is a no-op warning; its COMMIT ends ours.
 */
async function applyCompany(client: pg.Client, folder: string, production: boolean, acknowledged: string[]): Promise<number> {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('revbound-migrate'))");
    const journal: { entries: { tag: string; when: number }[] } = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8"));
    const exists = (await client.query("select to_regclass('drizzle.__drizzle_migrations') as t")).rows[0].t;
    const last = exists ? (await client.query("select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1")).rows[0] : undefined;
    const pending = journal.entries.filter((e) => !last || Number(last.created_at) < e.when)
      .map((e) => ({ id: `company:${e.tag.slice(0, 4)}`, sql: readFileSync(join(folder, `${e.tag}.sql`), "utf8") }));
    if (production) refuseDestructive(pending, acknowledged);
    await drizzleMigrate(drizzle({ client }), { migrationsFolder: folder, migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" });
    return pending.length;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export { PRODUCTION_DATABASE, isHosted };
