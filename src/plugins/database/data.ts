/** The Data view's routes: the company's `public` tables and the tables plugins declare, read-only (session GET). */
import pg from "pg";
import type { RouteCtx } from "revbound";
import { assertNotProduction, HttpError, json, PRODUCTION_DATABASE, toJson, value } from "revbound/kit";

const PAGE_SIZE = 100;
const CSV_ROWS = 10_000;
const CSV_BYTES = 5 * 1024 * 1024;

type Query = (text: string, values?: unknown[]) => Promise<pg.QueryArrayResult>;
type Db = { url: string; pool: pg.Pool; checked: boolean };
const POOL = Symbol.for("revbound/api/pool");

/** Runs fn inside BEGIN READ ONLY … ROLLBACK on this process's small pool, after the production-stamp check. */
async function readOnly<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const url = value("DATABASE_URL");
  if (!url) throw new HttpError(503, "DATABASE_URL is not set. Locally, start the app with `revbound dev`; hosted, connect a database.");
  const g = globalThis as unknown as Record<symbol, Db | undefined>;
  if (g[POOL]?.url !== url) {
    g[POOL]?.pool.end().catch(() => {});
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    pool.on("error", () => {}); // an idle client dropped by the server must not crash the process
    g[POOL] = { url, pool, checked: false };
  }
  const db = g[POOL]!;
  if (!db.checked) {
    await assertNotProduction(async (sql) => (await db.pool.query(sql)).rows, url).catch((e: Error) => {
      throw e.message === PRODUCTION_DATABASE ? new HttpError(403, e.message) : e;
    });
    db.checked = true;
  }
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    return await fn((text, values) => client.query({ text, values, rowMode: "array" }));
  } finally {
    client.release(await client.query("ROLLBACK").then(() => false, () => true)); // a client that cannot roll back is dropped
  }
}

const PUBLIC_TABLES = "information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'";

/** Tables plugins declare, by the name Data shows (`schema.name`). */
const declared = (ctx: RouteCtx) => new Map(ctx.manifest.tables.map((t) => [`${t.schema}.${t.name}`, t]));

/**
 * GET /data → { tables: [{ name, label?, estimatedRows }] }: the company's public tables, then the tables plugins declare
 * that exist; estimatedRows is null while Postgres has no estimate (-1) and for views.
 */
export async function tables(_req: Request, ctx: RouteCtx): Promise<Response> {
  const extra = [...declared(ctx).entries()];
  const { rows } = await readOnly(async (q) => {
    const own = await q(`select t.table_name, (select c.reltuples::float8 from pg_class c
         where c.relname = t.table_name and c.relnamespace = 'public'::regnamespace) from ${PUBLIC_TABLES} order by 1`);
    const found = extra.length ? await q(`select n.nspname || '.' || c.relname, c.relkind, c.reltuples::float8 from pg_class c join pg_namespace n
         on n.oid = c.relnamespace where n.nspname || '.' || c.relname = any($1)`, [extra.map(([k]) => k)]) : { rows: [] };
    const plugin = new Map(found.rows.map((r) => [r[0] as string, r]));
    return { rows: [...own.rows.map(([name, n]) => ({ name, n })),
      ...extra.flatMap(([k, t]) => (plugin.has(k) ? [{ name: k, label: t.label, n: plugin.get(k)![1] === "v" ? null : plugin.get(k)![2] }] : []))] };
  });
  return json({ tables: rows.map(({ name, label, n }: { name: unknown; label?: string; n: unknown }) =>
    ({ name, ...(label && { label }), estimatedRows: n == null || (n as number) < 0 ? null : Math.round(n as number) })) });
}

/** The quoted identifier of a listed table (public, or declared by a plugin); any other name is a 404. */
async function table(q: Query, name: string, ctx: RouteCtx): Promise<{ t: string; tie: string }> {
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  const plugin = declared(ctx).get(name);
  if (plugin) {
    const t = `${quote(plugin.schema)}.${quote(plugin.name)}`;
    const { rows } = await q("select c.relkind from pg_class c where c.oid = to_regclass($1)", [t]);
    // Views have no ctid; their rows sort by the first column.
    if (rows.length) return { t, tie: rows[0][0] === "v" ? "1" : "x.ctid" };
  }
  const { rows } = await q(`select 1 from ${PUBLIC_TABLES} and t.table_name = $1`, [name]);
  if (!rows.length) throw new HttpError(404, `No table "${name}"`);
  return { t: `"public".${quote(name)}`, tie: "x.ctid" };
}

const NUMERIC = new Set([20, 21, 23, 700, 701, 1700]), JSONB = new Set([114, 3802]);
const typeOf = (oid: number) => (NUMERIC.has(oid) ? "number" : oid === 16 ? "boolean" : JSONB.has(oid) ? "json" : "text");
const ident = (c: string) => `"${c.replaceAll('"', '""')}"`;
const OPERATORS: Record<string, string> = { eq: "=", ne: "is distinct from", gt: ">", lt: "<" };

/**
 * The table's columns, and the `where` / `order by` the query string asks for: `q` matches any value as text, `field`
 * with `operator` (eq, ne, gt, lt, missing) and `value` filters one column (numbers compare as numbers), `sort` and
 * `order` sort, and `columns` (comma-separated) picks the columns returned.
 */
async function view(q: Query, name: string, p: URLSearchParams, ctx: RouteCtx) {
  const { t, tie } = await table(q, name, ctx);
  const head = await q(`select * from ${t} limit 0`);
  const fields = head.fields.map((f) => ({ name: f.name, type: typeOf(f.dataTypeID) }));
  const known = (c: string | null) => (c && fields.some((f) => f.name === c) ? c : null);
  const values: unknown[] = [], where: string[] = [];
  const search = p.get("q")?.trim();
  if (search) where.push(`x::text ilike $${values.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`)}`);
  const field = known(p.get("field")), op = p.get("operator") ?? "eq";
  if (field && op === "missing") where.push(`x.${ident(field)} is null`);
  else if (field && OPERATORS[op] && p.has("value")) {
    const number = fields.find((f) => f.name === field)!.type === "number" && (op === "gt" || op === "lt");
    if (number && !(p.get("value")!.trim() && Number.isFinite(Number(p.get("value"))))) throw new HttpError(400, `${field} holds numbers: compare it with a number.`);
    where.push(`x.${ident(field)}${number ? "" : "::text"} ${OPERATORS[op]} $${values.push(p.get("value"))}${number ? "::numeric" : ""}`);
  }
  const sort = known(p.get("sort")), order = p.get("order") === "desc" ? "desc" : "asc";
  const picked = (p.get("columns") ?? "").split(",").filter(known);
  const columns = picked.length ? picked : fields.map((f) => f.name);
  // The name column stays on screen while the grid scrolls sideways.
  const pinned = columns.find((c) => /(^|_)(name|title)$/i.test(c)) ?? null;
  return {
    t, fields, columns, pinned, values, select: columns.map((c) => `x.${ident(c)}`).join(", "),
    where: where.length ? `where ${where.join(" and ")}` : "", order: `order by ${sort ? `x.${ident(sort)} ${order} nulls last, ` : ""}${tie}`,
  };
}

/**
 * GET /data/<table>?offset=&limit= (plus view()'s filters) → { table, fields, columns, pinned, rows, offset, total }:
 * up to 200 rows from `offset`, and how many rows match.
 */
export async function page(req: Request, ctx: RouteCtx): Promise<Response> {
  const name = ctx.params.table, p = new URL(req.url).searchParams;
  const offset = Number(p.get("offset") ?? 0), limit = Number(p.get("limit") ?? PAGE_SIZE);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new HttpError(400, "offset must be a whole number from 0 and limit from 1 to 200");
  }
  return json(await readOnly(async (q) => {
    const v = await view(q, name, p, ctx);
    const [rows, count] = [await q(`select ${v.select} from ${v.t} x ${v.where} ${v.order} limit ${limit} offset ${offset}`, v.values),
      await q(`select count(*)::float8 from ${v.t} x ${v.where}`, v.values)];
    return { table: name, fields: v.fields, columns: v.columns, pinned: v.pinned, rows: rows.rows, offset, total: count.rows[0][0] };
  }));
}

/** A CSV cell. Text a spreadsheet would run as a formula (= + - @ first, or a tab or CR) gets a leading '; numbers stay. */
function csvCell(v: unknown): string {
  let s =
    v == null ? ""
    : v instanceof Date ? (Number.isNaN(v.getTime()) ? String(v) : v.toISOString())
    : v instanceof Uint8Array ? `\\x${Buffer.from(v).toString("hex")}`
    : typeof v === "object" ? toJson(v)
    : String(v);
  if (/^\s*[=+\-@]|^[\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * GET /data/<table>/csv or /json (with view()'s filters, sort and columns) → up to 10,000 rows / 5 MB as a download; when
 * capped, `x-gtm-truncated: 1` and, in CSV, a final `# truncated`.
 */
export async function exported(req: Request, ctx: RouteCtx): Promise<Response> {
  const { table: name, format } = ctx.params, p = new URL(req.url).searchParams;
  if (format !== "csv" && format !== "json") throw new HttpError(404, `No export format "${format}"`);
  const line = format === "csv" ? (row: unknown[]) => row.map(csvCell).join(",") : (row: unknown[], cols: string[]) =>
    toJson(Object.fromEntries(cols.map((c, i) => [c, row[i]])));
  const { lines, truncated } = await readOnly(async (q) => {
    const v = await view(q, name, p, ctx);
    const lines: string[] = format === "csv" ? [v.columns.map(csvCell).join(",")] : [];
    let bytes = 0;
    // Chunks of 1,000 keep memory near the cap; past 10,000 rows or 5 MB (less room for the notice) it stops.
    for (let offset = 0; ; offset += 1000) {
      const r = await q(`select ${v.select} from ${v.t} x ${v.where} ${v.order} limit 1000 offset ${offset}`, v.values);
      for (const text of r.rows.map((row) => line(row, v.columns))) {
        bytes += Buffer.byteLength(text) + 2;
        if (lines.length > CSV_ROWS || bytes > CSV_BYTES - 64) return { lines, truncated: true };
        lines.push(text);
      }
      if (r.rows.length < 1000) return { lines, truncated: false };
    }
  });
  const body = format === "csv" ? `${lines.join("\n")}\n${truncated ? "# truncated\n" : ""}` : `[${lines.join(",\n")}]\n`;
  const headers = { "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json", "cache-control": "no-store",
    "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}.${format}"`, ...(truncated && { "x-gtm-truncated": "1" }) };
  return new Response(body, { headers });
}
