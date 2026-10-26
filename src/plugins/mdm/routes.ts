/** The People, Companies and Signals views' routes (session GET), read-only: 50 records a page, newest first. */
import { sql, type SQL } from "drizzle-orm";
import type { RouteCtx } from "revbound";
import { HttpError, json } from "revbound/kit";

type Row = Record<string, any>;
const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIODS: Record<string, string> = { day: "1 day", week: "7 days", month: "30 days" };
const AT = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

const rows = async (ctx: RouteCtx, q: SQL) => (await ctx.get("database").db().execute(q)).rows as Row[];

/** `before` (a page's `next`: the last row's exact time and id) as a condition on `at` and `id`. */
function before(p: URLSearchParams, at: string, id: string): SQL {
  const b = p.get("before");
  if (!b) return sql`true`;
  const [time, key] = b.split("~");
  if (Number.isNaN(Date.parse(time)) || !UUID.test(key ?? "")) throw new HttpError(400, "before must be a page's next");
  return sql`(${sql.raw(at)}, ${sql.raw(id)}) < (${time}::timestamptz, ${key}::uuid)`;
}
/** The first 50 rows, whether there are more, and the next page's `before`. */
function page(found: Row[], map: (r: Row) => unknown) {
  const last = found.length > PAGE ? found[PAGE - 1] : undefined;
  return { data: found.slice(0, PAGE).map(map), next: last ? `${last.at}~${last.id}` : null };
}
const like = (p: URLSearchParams) => {
  const q = p.get("q")?.trim();
  return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
};
/** A record's keys and where each field came from. */
async function provenance(ctx: RouteCtx, id: string) {
  const [keys, fields] = await Promise.all([
    rows(ctx, sql`select key, value, source, workflow, created_at from revbound_mdm.keys where record_id = ${id} order by created_at, key`),
    rows(ctx, sql`select f.field, f.value, f.source, f.workflow, f.run_id, f.set_at, coalesce(c.name, c.domain) as company from revbound_mdm.fields f
      left join revbound_mdm.companies c on f.field = 'company' and c.id::text = f.value #>> '{}' where f.record_id = ${id} order by f.field`),
  ]);
  return {
    keys: keys.map((k) => ({ key: k.key, value: k.value, source: k.source, workflow: k.workflow, since: iso(k.created_at) })),
    fields: fields.map((f) => ({ field: f.field, value: f.value, source: f.source, workflow: f.workflow, runId: f.run_id, setAt: iso(f.set_at),
      ...(f.field === "company" && { company: f.company }) })),
  };
}
const signalRow = (s: Row) => ({ id: s.id, type: s.type, key: s.key, occurredAt: iso(s.occurred_at), source: s.source, workflow: s.workflow,
  runId: s.run_id, data: s.data ?? {}, about: { type: s.record_type, id: s.record_id, label: s.label ?? null } });
const SIGNALS = sql`select s.*, ${AT("s.occurred_at")} as at, coalesce(p.name, p.email, p.linkedin, c.name, c.domain, c.linkedin) as label
  from revbound_mdm.signals s left join revbound_mdm.people p on p.id = s.record_id left join revbound_mdm.companies c on c.id = s.record_id`;
/** The live id of a record: a merged one answers with the record it went into. */
async function live(ctx: RouteCtx, table: SQL, id: string): Promise<Row> {
  if (!UUID.test(id)) throw new HttpError(404, "No such record");
  const [r] = await rows(ctx, sql`select coalesce(merged_into, id) as id from ${table} where id = ${id}`);
  if (!r) throw new HttpError(404, "No such record");
  return (await rows(ctx, sql`select * from ${table} where id = ${r.id}`))[0];
}

const PERSON = sql`select p.*, ${AT("p.created_at")} as at, c.name as company_name, c.domain as company_domain,
  (select count(*)::int from revbound_mdm.signals s where s.record_id = p.id) as signals
  from revbound_mdm.people p left join revbound_mdm.companies c on c.id = p.company_id`;
const personRow = (r: Row) => ({ id: r.id, name: r.name, email: r.email, linkedin: r.linkedin, title: r.title, data: r.data ?? {},
  company: r.company_id ? { id: r.company_id, name: r.company_name, domain: r.company_domain } : null, signals: r.signals,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

/** GET /mdm/people?q=&before= → { data, next }: people, newest first; `q` matches names, titles and every key. */
export async function people(req: Request, ctx: RouteCtx): Promise<Response> {
  const p = new URL(req.url).searchParams, q = like(p), where = [sql`p.merged_into is null`, before(p, "p.created_at", "p.id")];
  if (q) where.push(sql`(p.name ilike ${q} or p.title ilike ${q} or exists (select 1 from revbound_mdm.keys k where k.record_id = p.id and k.value ilike ${q}))`);
  return json(page(await rows(ctx, sql`${PERSON} where ${sql.join(where, sql` and `)} order by p.created_at desc, p.id desc limit ${PAGE + 1}`), personRow));
}

/** GET /mdm/people/:id → { person, keys, fields, signals }; a merged id answers with the person it went into. */
export async function person(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await live(ctx, sql`revbound_mdm.people`, ctx.params.id);
  const [r] = await rows(ctx, sql`${PERSON} where p.id = ${id}`);
  const signals = await rows(ctx, sql`${SIGNALS} where s.record_id = ${id} order by s.occurred_at desc, s.id desc limit ${PAGE}`);
  return json({ person: personRow(r), ...(await provenance(ctx, id)), signals: signals.map(signalRow) });
}

const COMPANY = sql`select c.*, ${AT("c.created_at")} as at,
  (select count(*)::int from revbound_mdm.people p where p.company_id = c.id and p.merged_into is null) as people,
  (select count(*)::int from revbound_mdm.signals s where s.record_id = c.id) as signals
  from revbound_mdm.companies c`;
const companyRow = (r: Row) => ({ id: r.id, name: r.name, domain: r.domain, linkedin: r.linkedin, data: r.data ?? {}, people: r.people, signals: r.signals,
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

/** GET /mdm/companies?q=&before= → { data, next }: companies, newest first. */
export async function companies(req: Request, ctx: RouteCtx): Promise<Response> {
  const p = new URL(req.url).searchParams, q = like(p), where = [sql`c.merged_into is null`, before(p, "c.created_at", "c.id")];
  if (q) where.push(sql`(c.name ilike ${q} or exists (select 1 from revbound_mdm.keys k where k.record_id = c.id and k.value ilike ${q}))`);
  return json(page(await rows(ctx, sql`${COMPANY} where ${sql.join(where, sql` and `)} order by c.created_at desc, c.id desc limit ${PAGE + 1}`), companyRow));
}

/** GET /mdm/companies/:id → { company, keys, fields, people, signals }. */
export async function company(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { id } = await live(ctx, sql`revbound_mdm.companies`, ctx.params.id);
  const [r] = await rows(ctx, sql`${COMPANY} where c.id = ${id}`);
  const [staff, signals] = await Promise.all([
    rows(ctx, sql`${PERSON} where p.company_id = ${id} and p.merged_into is null order by p.name nulls last, p.id limit ${PAGE}`),
    rows(ctx, sql`${SIGNALS} where s.record_id = ${id} order by s.occurred_at desc, s.id desc limit ${PAGE}`),
  ]);
  return json({ company: companyRow(r), ...(await provenance(ctx, id)), people: staff.map(personRow), signals: signals.map(signalRow) });
}

/** GET /mdm/signals?type=&period=&q=&before= → { data, next, types }: signals, newest first, and every type there is. */
export async function signals(req: Request, ctx: RouteCtx): Promise<Response> {
  const p = new URL(req.url).searchParams, q = like(p), type = p.get("type"), period = PERIODS[p.get("period") ?? ""];
  const where = [before(p, "s.occurred_at", "s.id")];
  if (type) where.push(sql`s.type = ${type}`);
  if (period) where.push(sql`s.occurred_at >= now() - ${period}::interval`);
  if (q) where.push(sql`(s.type ilike ${q} or s.source ilike ${q} or s.key ilike ${q} or coalesce(p.name, p.email, p.linkedin, c.name, c.domain, c.linkedin) ilike ${q})`);
  const [found, types] = await Promise.all([
    rows(ctx, sql`${SIGNALS} where ${sql.join(where, sql` and `)} order by s.occurred_at desc, s.id desc limit ${PAGE + 1}`),
    rows(ctx, sql`select distinct type from revbound_mdm.signals order by type`),
  ]);
  return json({ ...page(found, signalRow), types: types.map((t) => t.type) });
}
