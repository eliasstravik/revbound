/**
 * The `mdm` slot (MdmSlotV1): match every company, person and signal a workflow finds to the one record it already is,
 * or create it, and keep where each field came from. Every write runs in one transaction under one advisory lock, so
 * two runs finding the same company at once still make one record.
 */
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Ctx } from "revbound";
import { fieldName, keysOf, MdmInputError, signalType } from "./keys.js";
import type { Company, CompanyInput, Known, MdmSlotV1, Origin, Person, PersonInput, RecordType, Ref, Signal, Upserted } from "./types.js";

type Row = Record<string, any>;
type Exec = { execute: (q: SQL) => Promise<{ rows: Row[] }> };
type Db = Exec & { transaction<T>(fn: (tx: Exec) => Promise<T>): Promise<T> };

const LOCK = sql`select pg_advisory_xact_lock(hashtext('revbound-mdm'))`;
const TABLES: Record<RecordType, SQL> = { person: sql`revbound_mdm.people`, company: sql`revbound_mdm.companies` };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (message: string) => new MdmInputError(message);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

const typeOf = (ref: Ref | undefined): RecordType => {
  if (ref?.type !== "person" && ref?.type !== "company") throw bad(`${JSON.stringify(ref?.type)} is not a record type (person or company).`);
  return ref.type;
};

/** `fields` as checked [name, JSON value] pairs; undefined values are left out. */
function fieldsOf(fields: Record<string, unknown> | undefined): [string, unknown][] {
  return entries(fields, "fields").map(([k, v]) => [fieldName(k), v]);
}

/** An object's [name, JSON value] pairs; undefined values are left out. */
function entries(value: Record<string, unknown> | undefined, what: string): [string, unknown][] {
  if (value == null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw bad(`${what} is an object of name → value.`);
  return Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, JSON.parse(JSON.stringify(v) ?? "null")]);
}

function originOf(o: Origin): Origin {
  const source = text(o?.source);
  if (!source || source.length > 100) throw bad("Every write names its source: the workflow or vendor the data came from (at most 100 characters).");
  return { source, workflow: o.workflow ?? null, runId: o.runId && UUID.test(o.runId) ? o.runId : null };
}

function toSignal(r: Row): Signal {
  return { id: r.id, type: r.type, about: { type: r.record_type, id: r.record_id }, key: r.key, occurredAt: iso(r.occurred_at)!, source: r.source,
    data: r.data ?? {}, workflow: r.workflow, runId: r.run_id, createdAt: iso(r.created_at)! };
}

export default function provide(ctx: Ctx): MdmSlotV1 {
  const db = () => ctx.get("database").db() as unknown as Db;
  const rows = async (q: SQL, tx: Exec = db()) => (await tx.execute(q)).rows;
  const one = async (q: SQL, tx?: Exec): Promise<Row | undefined> => (await rows(q, tx))[0];
  const write = <T>(fn: (tx: Exec) => Promise<T>) => db().transaction(async (tx) => { await tx.execute(LOCK); return fn(tx); });

  /** The live row of a record: a merged id gives the record it was merged into (merges keep chains one step long). */
  const resolve = async (type: RecordType, id: string, tx?: Exec): Promise<Row | undefined> => {
    if (typeof id !== "string" || !UUID.test(id)) return undefined;
    const r = await one(sql`select * from ${TABLES[type]} where id = ${id}`, tx);
    return r?.merged_into ? one(sql`select * from ${TABLES[type]} where id = ${r.merged_into}`, tx) : r;
  };
  const live = async (ref: Ref, tx?: Exec) => {
    const r = await resolve(typeOf(ref), ref.id, tx);
    if (!r) throw bad(`No ${ref.type} has the id ${ref.id}.`);
    return r;
  };

  const load = async <T extends Person | Company>(type: RecordType, r: Row, tx?: Exec): Promise<T> => {
    const keys = (await rows(sql`select key, value, source, created_at from revbound_mdm.keys where record_id = ${r.id} order by created_at, key, value`, tx))
      .map((k) => ({ key: k.key, value: k.value, source: k.source, since: iso(k.created_at)! }));
    const base = { id: r.id, name: r.name, linkedin: r.linkedin, data: r.data ?? {}, keys, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! };
    return (type === "person" ? { type, ...base, email: r.email, title: r.title, companyId: r.company_id } : { type, ...base, domain: r.domain }) as T;
  };

  /** The record the input's id or keys name (the strongest key wins), and the other records some of its keys belong to. */
  const match = async (type: RecordType, input: PersonInput | CompanyInput, keys: [string, string][], tx?: Exec) => {
    const byId = input.id != null ? await resolve(type, input.id, tx) : undefined;
    if (input.id != null && !byId) throw bad(`No ${type} has the id ${input.id}.`);
    const owned = keys.length ? await rows(sql`select key, value, record_id from revbound_mdm.keys where record_type = ${type}
      and (key, value) in (${sql.join(keys.map(([k, v]) => sql`(${k}, ${v})`), sql`, `)})`, tx) : [];
    const owner = new Map(owned.map((o) => [`${o.key}\n${o.value}`, o.record_id as string]));
    const found = keys.flatMap(([k, v]) => owner.get(`${k}\n${v}`) ?? []);
    const id: string | undefined = byId?.id ?? found[0];
    return { id, conflicts: [...new Set(found.filter((f) => f !== id))] };
  };

  /** Adds the keys no other record holds; returns the ones this record now has. */
  const addKeys = async (tx: Exec, type: RecordType, id: string, keys: [string, string][], o: Origin) => {
    if (!keys.length) return new Map<string, string>();
    await tx.execute(sql`insert into revbound_mdm.keys (record_type, key, value, record_id, source, workflow, run_id) values
      ${sql.join(keys.map(([k, v]) => sql`(${type}, ${k}, ${v}, ${id}, ${o.source}, ${o.workflow}, ${o.runId})`), sql`, `)} on conflict do nothing`);
    const mine = await rows(sql`select key, value from revbound_mdm.keys where record_id = ${id} order by created_at`, tx);
    return new Map(mine.reverse().map((k) => [k.key as string, k.value as string]));
  };

  /** Records who set each field and when (the latest write wins). */
  const setFields = async (tx: Exec, type: RecordType, id: string, fields: [string, unknown][], o: Origin) => {
    if (!fields.length) return;
    await tx.execute(sql`insert into revbound_mdm.fields (record_type, record_id, field, value, source, workflow, run_id) values
      ${sql.join(fields.map(([f, v]) => sql`(${type}, ${id}, ${f}, ${json(v)}, ${o.source}, ${o.workflow}, ${o.runId})`), sql`, `)}
      on conflict (record_id, field) do update set value = excluded.value, source = excluded.source, workflow = excluded.workflow,
        run_id = excluded.run_id, set_at = now()`);
  };

  /** Matches or creates the record, then writes what the input gives. */
  const upsert = async (tx: Exec, type: RecordType, input: PersonInput | CompanyInput, o: Origin) => {
    if (!input || typeof input !== "object") throw bad(`A ${type} is an object of its keys and fields.`);
    const keys = keysOf(type, input), fields = fieldsOf(input.fields);
    if (!keys.length && input.id == null) {
      throw bad(type === "person" ? "A person needs an email, a LinkedIn profile, an id in another system or a record id to match on."
        : "A company needs a domain, a LinkedIn page, an id in another system or a record id to match on.");
    }
    const m = await match(type, input, keys, tx);
    const id = m.id ?? randomUUID();
    if (!m.id) await tx.execute(sql`insert into ${TABLES[type]} (id) values (${id})`);
    const held = await addKeys(tx, type, id, keys, o);
    const named: [string, unknown][] = [["name", text(input.name)]];
    if (type === "person") {
      const p = input as PersonInput;
      let company: string | null = null;
      if (p.company && "type" in p.company && p.company.type === "company") company = (await live(p.company, tx)).id;
      else if (p.company) company = (await upsert(tx, "company", p.company as CompanyInput, o)).id;
      named.push(["title", text(p.title)], ["company", company]);
      await tx.execute(sql`update revbound_mdm.people set name = coalesce(${text(p.name)}, name), title = coalesce(${text(p.title)}, title),
        company_id = coalesce(${company}::uuid, company_id), email = coalesce(email, ${held.get("email") ?? null}),
        linkedin = coalesce(linkedin, ${held.get("linkedin") ?? null}), data = data || ${json(Object.fromEntries(fields))}, updated_at = now() where id = ${id}`);
    } else {
      await tx.execute(sql`update revbound_mdm.companies set name = coalesce(${text(input.name)}, name), domain = coalesce(domain, ${held.get("domain") ?? null}),
        linkedin = coalesce(linkedin, ${held.get("linkedin") ?? null}), data = data || ${json(Object.fromEntries(fields))}, updated_at = now() where id = ${id}`);
    }
    await setFields(tx, type, id, [...named.filter(([, v]) => v != null), ...fields], o);
    return { id, created: !m.id, conflicts: m.conflicts };
  };

  const upserted = async <T extends Person | Company>(type: RecordType, input: PersonInput | CompanyInput, origin: Origin): Promise<Upserted<T>> => {
    const o = originOf(origin);
    return write(async (tx) => {
      const r = await upsert(tx, type, input, o);
      return { ...(await load<T>(type, (await one(sql`select * from ${TABLES[type]} where id = ${r.id}`, tx))!, tx)), created: r.created, conflicts: r.conflicts };
    });
  };

  const find = async <T extends Person | Company>(type: RecordType, by: PersonInput | CompanyInput): Promise<T | null> => {
    const keys = keysOf(type, by ?? {});
    const id = by?.id != null ? (await resolve(type, by.id))?.id : (await match(type, {}, keys)).id;
    const r = id ? await resolve(type, id) : undefined;
    return r ? load<T>(type, r) : null;
  };

  /** Every known field of a record, its keys (email, domain, linkedin, id:<system>; the first of each) among them. */
  const known = async (ref: Ref, only?: string[]): Promise<Record<string, Known>> => {
    const r = await live(ref);
    if (only && !only.length) return {};
    const pick = (col: string) => (only ? sql`and ${sql.raw(col)} in (${sql.join(only.map((f) => sql`${String(f)}`), sql`, `)})` : sql``);
    const [keys, fields] = await Promise.all([
      rows(sql`select distinct on (key) key, value, source, workflow, run_id, created_at from revbound_mdm.keys where record_id = ${r.id} ${pick("key")}
        order by key, created_at, value`),
      rows(sql`select field, value, source, workflow, run_id, set_at from revbound_mdm.fields where record_id = ${r.id} ${pick("field")} order by field`),
    ]);
    return Object.fromEntries([
      ...keys.map((k) => [k.key, { value: k.value, source: k.source, workflow: k.workflow, runId: k.run_id, setAt: iso(k.created_at)! }]),
      ...fields.map((f) => [f.field, { value: f.value, source: f.source, workflow: f.workflow, runId: f.run_id, setAt: iso(f.set_at)! }]),
    ].sort(([a], [b]) => (a < b ? -1 : 1)));
  };

  return {
    upsertCompany: (input, origin) => upserted<Company>("company", input, origin),
    upsertPerson: (input, origin) => upserted<Person>("person", input, origin),
    findCompany: (by) => find<Company>("company", by),
    findPerson: (by) => find<Person>("person", by),
    known,

    async stale(ref, fields, opts = {}) {
      const have = await known(ref, fields), days = opts.maxAgeDays;
      const cutoff = days == null ? -Infinity : Date.now() - days * 86_400_000;
      return fields.filter((f) => !Object.hasOwn(have, f) || Date.parse(have[f].setAt) < cutoff);
    },

    async upsertSignal(input, origin) {
      const o = originOf(origin), type = signalType(input?.type);
      const at = input.at == null ? new Date() : new Date(input.at);
      if (Number.isNaN(at.getTime())) throw bad(`"${String(input.at)}" is not a time.`);
      const key = text(input.key) ?? at.toISOString(), data = entries(input.data, "A signal's data");
      return write(async (tx) => {
        const about = await live(input.about, tx), kind = typeOf(input.about);
        const same = await one(sql`select id from revbound_mdm.signals where record_id = ${about.id} and type = ${type} and key = ${key}`, tx);
        const r = same
          ? await one(sql`update revbound_mdm.signals set data = data || ${json(Object.fromEntries(data))}, occurred_at = least(occurred_at, ${at.toISOString()}::timestamptz),
              updated_at = now() where id = ${same.id} returning *`, tx)
          : await one(sql`insert into revbound_mdm.signals (id, record_type, record_id, type, key, occurred_at, source, workflow, run_id, data)
              values (${randomUUID()}, ${kind}, ${about.id}, ${type}, ${key}, ${at.toISOString()}, ${o.source}, ${o.workflow}, ${o.runId}, ${json(Object.fromEntries(data))}) returning *`, tx);
        return { ...toSignal(r!), created: !same };
      });
    },

    async signals(ref, opts = {}) {
      const r = await live(ref), limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
      const type = opts.type ? sql`and type = ${signalType(opts.type)}` : sql``;
      return (await rows(sql`select * from revbound_mdm.signals where record_id = ${r.id} ${type} order by occurred_at desc, id limit ${limit}`)).map(toSignal);
    },

    async merge(keep, drop) {
      const type = typeOf(keep);
      if (typeOf(drop) !== type) throw bad(`A ${keep.type} cannot be merged with a ${drop.type}.`);
      return write(async (tx) => {
        const [k, d] = [await live(keep, tx), await live(drop, tx)];
        if (k.id !== d.id) {
          await tx.execute(sql`update revbound_mdm.keys set record_id = ${k.id} where record_id = ${d.id}`);
          await tx.execute(sql`update revbound_mdm.fields set record_id = ${k.id} where record_id = ${d.id}
            and field not in (select field from revbound_mdm.fields where record_id = ${k.id})`);
          await tx.execute(sql`delete from revbound_mdm.fields where record_id = ${d.id}`);
          await tx.execute(sql`update revbound_mdm.signals s set record_id = ${k.id}, updated_at = now() where record_id = ${d.id}
            and not exists (select 1 from revbound_mdm.signals t where t.record_id = ${k.id} and t.type = s.type and t.key = s.key)`);
          await tx.execute(sql`delete from revbound_mdm.signals where record_id = ${d.id}`);
          const t = TABLES[type];
          const cols = type === "person" ? ["name", "email", "linkedin", "title", "company_id"] : ["name", "domain", "linkedin"];
          await tx.execute(sql`update ${t} k set ${sql.raw(cols.map((c) => `${c} = coalesce(k.${c}, d.${c})`).join(", "))}, data = d.data || k.data, updated_at = now()
            from ${t} d where k.id = ${k.id} and d.id = ${d.id}`);
          if (type === "company") {
            await tx.execute(sql`update revbound_mdm.people set company_id = ${k.id} where company_id = ${d.id}`);
            await tx.execute(sql`update revbound_mdm.fields set value = ${json(k.id)} where field = 'company' and value = ${json(d.id)}`);
          }
          await tx.execute(sql`update ${t} set merged_into = ${k.id} where merged_into = ${d.id}`);
          await tx.execute(sql`update ${t} set merged_into = ${k.id}, merged_at = now(), updated_at = now() where id = ${d.id}`);
        }
        return load(type, (await one(sql`select * from ${TABLES[type]} where id = ${k.id}`, tx))!, tx);
      });
    },
  };
}
