/**
 * What `#gtm/mdm` exports: upsert, find, merge and "what is known since when" for people, companies and signals.
 * Workflow-safe: each call is a step of this plugin's step module, which stamps the run it came from.
 */
import type { Runtime } from "revbound";
import type { Company, CompanyInput, Known, Person, PersonInput, Ref, Signal, SignalInput, Upserted } from "./types.js";

export type * from "./types.js";

/** `source`: the workflow or vendor the data came from; it defaults to the running workflow's name. */
export type WriteOptions = { source?: string };

export type Api = {
  /** Matches the company on its keys (domain, LinkedIn page, ids) or creates it, then writes what is given: the one record. */
  upsertCompany(input: CompanyInput, opts?: WriteOptions): Promise<Upserted<Company>>;
  /** Matches the person on their keys (email, LinkedIn profile, ids) or creates them; `company` links where they work now. */
  upsertPerson(input: PersonInput, opts?: WriteOptions): Promise<Upserted<Person>>;
  /** Records a signal about a record once: the same record, type and key found again updates it. */
  upsertSignal(input: SignalInput, opts?: WriteOptions): Promise<Signal & { created: boolean }>;
  findCompany(by: Omit<CompanyInput, "name" | "fields">): Promise<Company | null>;
  findPerson(by: Omit<PersonInput, "name" | "title" | "company" | "fields">): Promise<Person | null>;
  /** Folds `drop` into `keep`; `keep`'s values win, and `drop`'s id finds `keep` from then on. */
  merge(keep: Ref, drop: Ref): Promise<Person | Company>;
  /** What is known about a record: each field's and key's value, source and when it was set. */
  known(ref: Ref, fields?: string[]): Promise<Record<string, Known>>;
  /** The fields to enrich: unknown ones, and with `maxAgeDays` ones set longer ago than that. */
  stale(ref: Ref, fields: string[], opts?: { maxAgeDays?: number }): Promise<string[]>;
  /** A record's signals, newest first. */
  signals(ref: Ref, opts?: { type?: string; limit?: number }): Promise<Signal[]>;
};

/** Just the reference, so a whole record can be passed where a Ref is wanted without sending it through a step. */
const ref = (r: Ref): Ref => ({ type: r?.type, id: r?.id });

export function bind(rt: Runtime): Api {
  const call = (op: string, ...args: unknown[]) => rt.step(op, args) as never;
  return {
    upsertCompany: (input, opts) => call("upsertCompany", input, opts),
    upsertPerson: (input, opts) => call("upsertPerson", input, opts),
    upsertSignal: (input, opts) => call("upsertSignal", { ...input, about: ref(input.about) }, opts),
    findCompany: (by) => call("findCompany", by),
    findPerson: (by) => call("findPerson", by),
    merge: (keep, drop) => call("merge", ref(keep), ref(drop)),
    known: (r, fields) => call("known", ref(r), fields),
    stale: (r, fields, opts) => call("stale", ref(r), fields, opts),
    signals: (r, opts) => call("signals", ref(r), opts),
  };
}
