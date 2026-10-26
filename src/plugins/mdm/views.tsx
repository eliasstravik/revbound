"use client";
import type { ReactNode } from "react";
import { Link, Search, Status, time, useApi, useQuery, type ViewProps } from "revbound/ui";
import "./mdm.css";

type CompanyRef = { id: string; name: string | null; domain: string | null };
type Person = { id: string; name: string | null; email: string | null; linkedin: string | null; title: string | null; company: CompanyRef | null;
  signals: number; data: Record<string, unknown>; createdAt: string; updatedAt: string };
type Company = { id: string; name: string | null; domain: string | null; linkedin: string | null; people: number; signals: number;
  data: Record<string, unknown>; createdAt: string; updatedAt: string };
type Signal = { id: string; type: string; key: string; occurredAt: string; source: string; workflow: string | null; data: Record<string, unknown>;
  about: { type: "person" | "company"; id: string; label: string | null } };
type Key = { key: string; value: string; source: string; workflow: string | null; since: string };
type Field = { field: string; value: unknown; source: string; workflow: string | null; setAt: string; company?: string | null };
type Page<T> = { data: T[]; next: string | null };

const label = (s: string) => s.replaceAll("_", " ");
const text = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const KEYS: Record<string, string> = { email: "Email", domain: "Domain", linkedin: "LinkedIn" };
const keyLabel = (k: string) => KEYS[k] ?? (k.startsWith("id:") ? `${k.slice(3)} id` : k);
const personName = (p: { name: string | null; email: string | null; linkedin: string | null }) => p.name ?? p.email ?? p.linkedin ?? "Unnamed person";
const companyName = (c: { name: string | null; domain: string | null }) => c.name ?? c.domain ?? "Unnamed company";
const href = { person: (id: string) => `/people/${id}`, company: (id: string) => `/companies/${id}` };

const When = ({ at }: { at: string }) => <time tabIndex={0} dateTime={at} title={new Date(at).toString()}>{time(at)}</time>;
const Out = ({ url, children }: { url: string; children: ReactNode }) => <a href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
const LinkedIn = ({ path }: { path: string | null }) => (path ? <Out url={`https://www.${path}`}>LinkedIn</Out> : <span className="muted">—</span>);
/** Who set it: the source, and the workflow it ran in when that is another name. */
const Source = ({ source, workflow }: { source: string; workflow: string | null }) => <>{source}
  {workflow && workflow !== source && <div className="muted">in <Link href={`/workflows/${encodeURIComponent(workflow)}`}>{workflow}</Link></div>}</>;

/** A list page: title, a toolbar (search and its own filters), the table, its empty state and the pages. */
function List<T>({ title, path, filters, head, row, empty, narrowedBy = [] }: { title: string; path: string; filters?: (go: (k: string, v: string) => void) => ReactNode;
  head: string[]; row: (item: T) => ReactNode; empty: string; narrowedBy?: string[] }) {
  const { params: p, href: link, go } = useQuery();
  const query = new URLSearchParams();
  for (const k of ["q", "before", ...narrowedBy]) if (p.get(k)) query.set(k, p.get(k)!);
  const state = useApi<Page<T>>(`${path}?${query}`, () => 15_000), d = state.data;
  const set = (k: string, v: string) => go({ [k]: v || undefined, before: undefined });
  return <>
    <div className="title-row"><h1>{title}</h1></div>
    <section className="pane mdm" aria-label={title}>
      <div className="toolbar">
        <Search label={`Search ${title.toLowerCase()}`} value={p.get("q") ?? ""} onChange={(q) => go({ q: q || undefined, before: undefined }, true)} />
        {filters?.(set)}
        <button type="button" onClick={state.reload}>Refresh</button>
      </div>
      <Status state={state} />
      {d && <>
        <div className="table-scroll">
          <table>
            <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{d.data.map(row)}</tbody>
          </table>
          {!d.data.length && <p className="notice">{query.size ? `No matching ${title.toLowerCase()}.` : empty}</p>}
        </div>
        <nav className="pagination" aria-label={`${title} pages`}>
          {p.has("before") && <Link href={link({ before: undefined })}>Newest</Link>}
          {d.next && <Link href={link({ before: d.next })}>Older</Link>}
        </nav>
      </>}
    </section>
  </>;
}

export function PeopleView() {
  return <List<Person> title="People" path="mdm/people" head={["Name", "Title", "Company", "Signals", "Added"]}
    empty="No people yet. Ask your agent for a workflow that finds people."
    row={(r) => <tr key={r.id}>
      <td><Link href={href.person(r.id)}>{personName(r)}</Link>{r.email && r.name && <div className="muted">{r.email}</div>}</td>
      <td>{r.title ?? <span className="muted">—</span>}</td>
      <td>{r.company ? <Link href={href.company(r.company.id)}>{companyName(r.company)}</Link> : <span className="muted">—</span>}</td>
      <td className="numeric">{r.signals || <span className="muted">—</span>}</td>
      <td><When at={r.createdAt} /></td>
    </tr>} />;
}

export function CompaniesView() {
  return <List<Company> title="Companies" path="mdm/companies" head={["Name", "LinkedIn", "People", "Signals", "Added"]}
    empty="No companies yet. Ask your agent for a workflow that finds companies."
    row={(r) => <tr key={r.id}>
      <td><Link href={href.company(r.id)}>{companyName(r)}</Link>{r.domain && r.name && <div className="muted">{r.domain}</div>}</td>
      <td><LinkedIn path={r.linkedin} /></td>
      <td className="numeric">{r.people || <span className="muted">—</span>}</td>
      <td className="numeric">{r.signals || <span className="muted">—</span>}</td>
      <td><When at={r.createdAt} /></td>
    </tr>} />;
}

const signalRow = (s: Signal, about = true) => <tr key={s.id}>
  <td><When at={s.occurredAt} /></td>
  <td>{label(s.type)}</td>
  {about && <td><Link href={href[s.about.type](s.about.id)}>{s.about.label ?? (s.about.type === "person" ? "Unnamed person" : "Unnamed company")}</Link></td>}
  <td><Source source={s.source} workflow={s.workflow} /></td>
  <td className="mdm-detail" title={JSON.stringify(s.data)}>{Object.keys(s.data).length ? Object.entries(s.data).map(([k, v]) => `${label(k)}: ${text(v)}`).join(" · ") : s.key}</td>
</tr>;

export function SignalsView() {
  const types = useApi<Page<Signal> & { types: string[] }>("mdm/signals").data?.types ?? [];
  const { params: p } = useQuery();
  return <List<Signal> title="Signals" path="mdm/signals" head={["When", "Signal", "About", "Source", "Details"]} narrowedBy={["type", "period"]}
    empty="No signals yet. Ask your agent for a workflow that watches for job changes, funding or visits."
    filters={(set) => <>
      <select name="type" aria-label="Filter signals by type" value={p.get("type") ?? ""} onChange={(e) => set("type", e.target.value)}>
        <option value="">All signals</option>
        {types.map((t) => <option key={t} value={t}>{label(t)}</option>)}
      </select>
      <select name="period" aria-label="Filter signals by time" value={p.get("period") ?? ""} onChange={(e) => set("period", e.target.value)}>
        <option value="">All time</option>
        <option value="day">Past day</option>
        <option value="week">Past week</option>
        <option value="month">Past month</option>
      </select>
    </>}
    row={(s) => signalRow(s)} />;
}

/** A record's page: its main facts, what it was matched on, every known field with its source and date, and its signals. */
function RecordPage({ list, title, facts, keys, fields, signals, children }: { list: "people" | "companies"; title: string; facts: [string, ReactNode][];
  keys: Key[]; fields: Field[]; signals: Signal[]; children?: ReactNode }) {
  return <>
    <div className="title-row">
      <div className="breadcrumbs"><Link href={`/${list}`}>{list === "people" ? "People" : "Companies"}</Link><span aria-hidden="true">/</span><h1>{title}</h1></div>
    </div>
    <div className="page mdm-record">
      <dl className="mdm-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></div>)}</dl>
      {children}
      <h2>Matched on</h2>
      <div className="mdm-table"><table>
        <thead><tr><th>Key</th><th>Value</th><th>Source</th><th>Since</th></tr></thead>
        <tbody>{keys.map((k) => <tr key={`${k.key}:${k.value}`}><td>{keyLabel(k.key)}</td><td className="mono">{k.value}</td>
          <td><Source source={k.source} workflow={k.workflow} /></td><td><When at={k.since} /></td></tr>)}</tbody>
      </table></div>
      <h2>Known fields</h2>
      {fields.length ? <div className="mdm-table"><table>
        <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Set</th></tr></thead>
        <tbody>{fields.map((f) => <tr key={f.field}><td>{label(f.field)}</td>
          <td className="mdm-value">{f.field === "company" && typeof f.value === "string" ? <Link href={href.company(f.value)}>{f.company ?? "Unnamed company"}</Link> : text(f.value)}</td>
          <td><Source source={f.source} workflow={f.workflow} /></td><td><When at={f.setAt} /></td></tr>)}</tbody>
      </table></div> : <p className="notice">Nothing known yet beyond its keys.</p>}
      <h2>Signals</h2>
      {signals.length ? <div className="mdm-table"><table>
        <thead><tr><th>When</th><th>Signal</th><th>Source</th><th>Details</th></tr></thead>
        <tbody>{signals.map((s) => signalRow(s, false))}</tbody>
      </table></div> : <p className="notice">No signals yet.</p>}
    </div>
  </>;
}

type Detail = { keys: Key[]; fields: Field[]; signals: Signal[] };

export function PersonView({ params }: ViewProps) {
  const state = useApi<Detail & { person: Person }>(`mdm/people/${encodeURIComponent(params.id)}`, () => 30_000), d = state.data;
  if (!d) return <><div className="title-row"><div className="breadcrumbs"><Link href="/people">People</Link></div></div><Status state={state} /></>;
  const p = d.person;
  return <RecordPage list="people" title={personName(p)} keys={d.keys} fields={d.fields} signals={d.signals} facts={[
    ["Email", p.email], ["Title", p.title], ["Company", p.company && <Link href={href.company(p.company.id)}>{companyName(p.company)}</Link>],
    ["LinkedIn", p.linkedin && <LinkedIn path={p.linkedin} />], ["Added", <When at={p.createdAt} />], ["Updated", <When at={p.updatedAt} />],
  ]} />;
}

export function CompanyView({ params }: ViewProps) {
  const state = useApi<Detail & { company: Company; people: Person[] }>(`mdm/companies/${encodeURIComponent(params.id)}`, () => 30_000), d = state.data;
  if (!d) return <><div className="title-row"><div className="breadcrumbs"><Link href="/companies">Companies</Link></div></div><Status state={state} /></>;
  const c = d.company;
  return <RecordPage list="companies" title={companyName(c)} keys={d.keys} fields={d.fields} signals={d.signals} facts={[
    ["Domain", c.domain && <Out url={`https://${c.domain}`}>{c.domain}</Out>], ["LinkedIn", c.linkedin && <LinkedIn path={c.linkedin} />],
    ["Added", <When at={c.createdAt} />], ["Updated", <When at={c.updatedAt} />],
  ]}>
    <h2>People</h2>
    {d.people.length ? <div className="mdm-table"><table>
      <thead><tr><th>Name</th><th>Title</th><th>Email</th></tr></thead>
      <tbody>{d.people.map((p) => <tr key={p.id}><td><Link href={href.person(p.id)}>{personName(p)}</Link></td>
        <td>{p.title ?? <span className="muted">—</span>}</td><td>{p.email ?? <span className="muted">—</span>}</td></tr>)}</tbody>
    </table></div> : <p className="notice">No people at this company yet.</p>}
  </RecordPage>;
}
