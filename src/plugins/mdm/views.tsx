"use client";
import type { ReactNode } from "react";
import { DataTable, EmptyState, Link, PageHeader, Search, Status, Toolbar, useApi, useQuery, When, type Column, type ViewProps } from "revbound/ui";
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

/** A field or signal name as words: "job_change" is "Job change". */
const label = (s: string) => { const words = s.replaceAll("_", " "); return words ? words[0].toUpperCase() + words.slice(1) : words; };
const text = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const KEYS: Record<string, string> = { email: "Email", domain: "Domain", linkedin: "LinkedIn" };
const keyLabel = (k: string) => KEYS[k] ?? (k.startsWith("id:") ? `${label(k.slice(3))} id` : label(k));
const personName = (p: { name: string | null; email: string | null; linkedin: string | null }) => p.name ?? p.email ?? p.linkedin ?? "Unnamed person";
const companyName = (c: { name: string | null; domain: string | null }) => c.name ?? c.domain ?? "Unnamed company";
const href = { person: (id: string) => `/people/${id}`, company: (id: string) => `/companies/${id}` };

const Out = ({ url, children }: { url: string; children: ReactNode }) => <a href={url} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
const LinkedIn = ({ path }: { path: string | null }) => (path ? <Out url={`https://www.${path}`}>LinkedIn</Out> : null);
/** A long value on one line, cut with its whole text as tooltip. */
const Clip = ({ children }: { children: string | null }) => (children ? <span className="clip" title={children}>{children}</span> : null);
/** A count that says what it counts on a phone's card, where no column heading stands above it. */
const Counted = ({ n, one, many }: { n: number; one: string; many: string }) => (n ? <>{n}<span className="card-only"> {n === 1 ? one : many}</span></> : null);
/** Who set it: the source, and the workflow it ran in when that is another name. */
const Source = ({ source, workflow }: { source: string; workflow: string | null }) => <>{source}
  {workflow && workflow !== source && <div className="muted">in <Link className="link" href={`/workflows/${encodeURIComponent(workflow)}`}>{workflow}</Link></div>}</>;

/** What a signal says, as a sentence for the kinds this knows; else its details as "Name: value" pairs. */
function says(s: Signal): string {
  const d = s.data, t = (k: string) => (typeof d[k] === "string" || typeof d[k] === "number" ? String(d[k]) : "");
  if (s.type === "job_change" && t("to")) return `Became ${t("to")}${t("from") ? `, was ${t("from")}` : ""}`;
  if (s.type === "funding" && (t("amount") || t("round"))) return t("amount") ? `Raised ${t("amount")}${t("round") ? ` (${t("round")})` : ""}` : `Raised a ${t("round")} round`;
  return Object.keys(d).length ? Object.entries(d).map(([k, v]) => `${label(k)}: ${text(v)}`).join(" · ") : s.key;
}

/** A list page: title, a toolbar (search and its own filters), the table (cards on a phone), its empty state and the pages. */
function List<T extends { id: string }>({ title, path, filters, columns, empty, narrowedBy = [] }: { title: string; path: string; filters?: (go: (k: string, v: string) => void) => ReactNode;
  columns: Column<T>[]; empty: string; narrowedBy?: string[] }) {
  const { params: p, href: link, go } = useQuery();
  const query = new URLSearchParams();
  for (const k of ["q", "before", ...narrowedBy]) if (p.get(k)) query.set(k, p.get(k)!);
  const state = useApi<Page<T>>(`${path}?${query}`, () => 15_000), d = state.data;
  const set = (k: string, v: string) => go({ [k]: v || undefined, before: undefined });
  return <>
    <PageHeader title={title} />
    <section className="pane mdm" aria-label={title}>
      <Toolbar state={state} active={narrowedBy.filter((k) => p.get(k)).length} filters={filters?.(set)}
        search={<Search label={`Search ${title.toLowerCase()}`} value={p.get("q") ?? ""} onChange={(q) => go({ q: q || undefined, before: undefined }, true)} />} />
      <Status state={state} />
      {d && <>
        <div className="table-scroll">
          {d.data.length ? <DataTable label={title} columns={columns} rows={d.data} id={(r) => r.id} />
            : <EmptyState action={query.size > 0 && <Link className="button" href={link(Object.fromEntries(["q", "before", ...narrowedBy].map((k) => [k, undefined])))}>Show all {title.toLowerCase()}</Link>}>
              {query.size ? `No matching ${title.toLowerCase()}.` : empty}</EmptyState>}
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
  return <List<Person> title="People" path="mdm/people" empty="No people yet. Ask your agent for a workflow that finds people." columns={[
    { head: "Name", cell: (r) => <><Link href={href.person(r.id)}>{personName(r)}</Link>{r.email && r.name && <div className="muted">{r.email}</div>}</> },
    { head: "Title", cell: (r) => <Clip>{r.title}</Clip> },
    { head: "Company", cell: (r) => r.company && <Link className="clip" href={href.company(r.company.id)} title={companyName(r.company)}>{companyName(r.company)}</Link> },
    { head: "Signals", numeric: true, cell: (r) => <Counted n={r.signals} one="signal" many="signals" /> },
    { head: "Added", top: true, cell: (r) => <When at={r.createdAt} /> },
  ]} />;
}

export function CompaniesView() {
  return <List<Company> title="Companies" path="mdm/companies" empty="No companies yet. Ask your agent for a workflow that finds companies." columns={[
    { head: "Name", cell: (r) => <><Link href={href.company(r.id)}>{companyName(r)}</Link>{r.domain && r.name && <div className="muted">{r.domain}</div>}</> },
    { head: "LinkedIn", cell: (r) => <LinkedIn path={r.linkedin} /> },
    { head: "People", numeric: true, cell: (r) => <Counted n={r.people} one="person" many="people" /> },
    { head: "Signals", numeric: true, cell: (r) => <Counted n={r.signals} one="signal" many="signals" /> },
    { head: "Added", top: true, cell: (r) => <When at={r.createdAt} /> },
  ]} />;
}

/** A signal's columns: what happened, to whom (left out on that record's own page), what it says, who saw it, when. */
const signalColumns = (about = true): Column<Signal>[] => [
  { head: "Signal", cell: (s) => <span className="mdm-signal">{label(s.type)}</span> },
  ...(about ? [{ head: "About", cell: (s: Signal) => <Link href={href[s.about.type](s.about.id)}>{s.about.label ?? (s.about.type === "person" ? "Unnamed person" : "Unnamed company")}</Link> }] : []),
  { head: "Details", className: "mdm-value", cell: (s) => says(s) },
  { head: "Source", cell: (s) => <Source source={s.source} workflow={s.workflow} /> },
  { head: "When", top: true, cell: (s) => <When at={s.occurredAt} /> },
];

export function SignalsView() {
  const types = useApi<Page<Signal> & { types: string[] }>("mdm/signals").data?.types ?? [];
  const { params: p } = useQuery();
  return <List<Signal> title="Signals" path="mdm/signals" columns={signalColumns()} narrowedBy={["type", "period"]}
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
    </>} />;
}

/** A record's page: its main facts, what identifies it, every detail with where it came from and when, and its signals. */
function RecordPage({ list, title, facts, keys, fields, signals, children }: { list: "people" | "companies"; title: string; facts: [string, ReactNode][];
  keys: Key[]; fields: Field[]; signals: Signal[]; children?: ReactNode }) {
  return <>
    <PageHeader title={title} crumb={{ href: `/${list}`, label: list === "people" ? "People" : "Companies" }} />
    <div className="page mdm-record">
      <dl className="facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {children}
      <h2>Identifiers</h2>
      <p className="muted">What this record is matched on, and where each one came from.</p>
      <DataTable label="Identifiers" rows={keys} id={(k) => `${k.key}:${k.value}`} columns={[
        { head: "Identifier", cell: (k) => keyLabel(k.key) }, { head: "Value", className: "mono mdm-value", cell: (k) => k.value },
        { head: "Source", cell: (k) => <Source source={k.source} workflow={k.workflow} /> }, { head: "Since", top: true, cell: (k) => <When at={k.since} /> },
      ]} />
      <h2>Details</h2>
      <p className="muted">Where each value came from.</p>
      {fields.length ? <DataTable label="Details" rows={fields} id={(f) => f.field} columns={[
        { head: "Detail", cell: (f) => label(f.field) },
        { head: "Value", className: "mdm-value", cell: (f) => (f.field === "company" && typeof f.value === "string" ? <Link className="link" href={href.company(f.value)}>{f.company ?? "Unnamed company"}</Link> : text(f.value)) },
        { head: "Source", cell: (f) => <Source source={f.source} workflow={f.workflow} /> }, { head: "Set", top: true, cell: (f) => <When at={f.setAt} /> },
      ]} /> : <EmptyState>Nothing known yet beyond its identifiers.</EmptyState>}
      <h2>Signals</h2>
      {signals.length ? <DataTable label="Signals" rows={signals} id={(s) => s.id} columns={signalColumns(false)} /> : <EmptyState>No signals yet.</EmptyState>}
    </div>
  </>;
}

type Detail = { keys: Key[]; fields: Field[]; signals: Signal[] };

export function PersonView({ params }: ViewProps) {
  const state = useApi<Detail & { person: Person }>(`mdm/people/${encodeURIComponent(params.id)}`, () => 30_000), d = state.data;
  if (!d) return <><PageHeader title="Person" crumb={{ href: "/people", label: "People" }} /><Status state={state} /></>;
  const p = d.person;
  return <RecordPage list="people" title={personName(p)} keys={d.keys} fields={d.fields} signals={d.signals} facts={[
    ["Email", p.email], ["Title", p.title], ["Company", p.company && <Link className="link" href={href.company(p.company.id)}>{companyName(p.company)}</Link>],
    ["LinkedIn", p.linkedin && <LinkedIn path={p.linkedin} />], ["Added", <When at={p.createdAt} />], ["Updated", <When at={p.updatedAt} />],
  ]} />;
}

export function CompanyView({ params }: ViewProps) {
  const state = useApi<Detail & { company: Company; people: Person[] }>(`mdm/companies/${encodeURIComponent(params.id)}`, () => 30_000), d = state.data;
  if (!d) return <><PageHeader title="Company" crumb={{ href: "/companies", label: "Companies" }} /><Status state={state} /></>;
  const c = d.company;
  return <RecordPage list="companies" title={companyName(c)} keys={d.keys} fields={d.fields} signals={d.signals} facts={[
    ["Domain", c.domain && <Out url={`https://${c.domain}`}>{c.domain}</Out>], ["LinkedIn", c.linkedin && <LinkedIn path={c.linkedin} />],
    ["Added", <When at={c.createdAt} />], ["Updated", <When at={c.updatedAt} />],
  ]}>
    <h2>People</h2>
    {d.people.length ? <DataTable label="People" rows={d.people} id={(p) => p.id} columns={[
      { head: "Name", cell: (p) => <Link href={href.person(p.id)}>{personName(p)}</Link> }, { head: "Title", cell: (p) => p.title }, { head: "Email", cell: (p) => p.email },
    ]} /> : <EmptyState>No people at this company yet.</EmptyState>}
  </RecordPage>;
}
