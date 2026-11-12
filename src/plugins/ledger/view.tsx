"use client";
import { useEffect, useRef, useState } from "react";
import type { Manifest } from "revbound";
import { apiUrl, DataTable, duration, EmptyState, isActive, Link, PageHeader, Search, Status, StatusBadge, time, Toolbar, usd, useApi, useQuery, vercelUrl, When,
  type Column, type TabProps, type ViewProps } from "revbound/ui";
import { refusal, splitReason } from "./words.js";
import "./runs.css";

type Run = { id: string; sdkRunId: string | null; workflow: string; trigger: string; preview: boolean; status: string; reason: string | null;
  parentRunId: string | null; rootRunId: string; approvedMaxUsd: number | null; approvalNote: string | null; startedAt: string; finishedAt: string | null;
  costUsd: number; calls: number; unmetered: number };
type Where = { local: boolean; environment: string };
type Runs = Where & { data: Run[]; hasMore: boolean; next: string | null };
type Detail = Where & { run: Run; parent: Run | null; children: Run[]; result: string | null };

const STATUSES = [["running", "Running"], ["completed", "Completed"], ["failed", "Failed"], ["not_started", "Not started"], ["cancelled", "Cancelled"], ["unknown", "Unknown"]];
const TRIGGERS: Record<string, string> = { cli: "From the command line", http: "By request", cron: "On its schedule", webhook: "By a webhook", child: "By another run", external: "Outside Revbound" };
const started = (run: Run) => run.status !== "refused" && run.status !== "start_failed";

/** How long a run took, or has taken so far (ticks every second while it runs); nothing for a run that never started. */
function Duration({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());
  const going = isActive(run.status);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => document.hidden || setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [going]);
  if (!started(run) || (!run.finishedAt && !going)) return null;
  return <>{duration((run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime())}</>;
}

/** A run's technical trace, or with no run all of them: the local run inspector (only on this computer), or Vercel's dashboard. */
function traceLink(d: Where, sdkRunId?: string | null) {
  if (sdkRunId === null) return null;
  const id = sdkRunId && encodeURIComponent(sdkRunId);
  if (d.local) return typeof location !== "undefined" && ["127.0.0.1", "localhost"].includes(location.hostname) ? apiUrl(id ? `inspector/run/${id}` : "inspector") : null;
  return id ? vercelUrl(`/workflows/runs/${id}?environment=${d.environment}`, "Workflow run") : vercelUrl(`/workflows?environment=${d.environment}`, "Workflow runs");
}

function Cost({ run }: { run: Run }) {
  if (run.unmetered && !run.costUsd) return <span className="muted" title={`${run.unmetered} call(s) on your own plan`}>Not priced</span>;
  return run.calls ? <>{usd(run.costUsd)}</> : null;
}

const approval = (run: Run) => (run.preview ? "Preview" : run.approvedMaxUsd != null ? `Approved up to ${usd(run.approvedMaxUsd)}` : run.parentRunId ? "Part of a larger run" : null);

/** What the page links to: Chat and Connections when the project has them, and the key names a message may mention. */
function useLinks(manifest: Manifest) {
  const has = (path: string) => manifest.views.some((v) => v.path === path);
  const keys = useApi<{ connections: { name: string }[] }>(has("connections") ? "connections" : null).data?.connections.map((c) => c.name) ?? [];
  return { chat: has("chat"), keys };
}
type Links = ReturnType<typeof useLinks>;

/** Why a run failed or did not start, in the person's words: the message, then the step and the next thing to do. */
function Reason({ run, links, full }: { run: Run; links: Links; full?: boolean }) {
  if (!run.reason || run.status === "completed") return null;
  const refused = run.status === "refused" ? refusal(run.reason, run.workflow) : null, split = splitReason(run.reason);
  const message = refused?.message ?? split.message, key = links.keys.find((k) => message.includes(k)), next = links.chat ? refused?.next : undefined;
  return (
    <div className={full ? "run-reason full" : "run-reason"}>
      <p title={full ? undefined : message}>{message}</p>
      {(split.step || next || key) && <p className="muted run-next">
        {split.step && <span>Step {split.step} · {split.tries} {split.tries === 1 ? "try" : "tries"}</span>}
        {next && <Link href={`/chat?draft=${encodeURIComponent(next.draft)}`}>{next.label}</Link>}
        {key && <Link href="/connections">Fix in Connections</Link>}
      </p>}
    </div>
  );
}

/** One run in full, beside the list (over it on a small screen): `?run=<id>`, so its address opens the same panel. */
function RunPanel({ id, links, runHref, close }: { id: string; links: Links; runHref: (id: string) => string; close: () => void }) {
  const state = useApi<Detail>(`ledger/runs/${encodeURIComponent(id)}`, (d) => (isActive(d.run.status) ? 3000 : undefined)), d = state.data, run = d?.run;
  const button = useRef<HTMLButtonElement>(null), [copied, setCopied] = useState(false);
  useEffect(() => {
    button.current?.focus();
    const keys = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("dialog[open], [popover]:popover-open") && close();
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [id]);
  const trace = d && run && traceLink(d, run.sdkRunId), note = run && approval(run);
  const copy = () => navigator.clipboard.writeText(d?.result ?? "").then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined);
  const others = (title: string, list: Run[]) => list.length > 0 && <section>
    <h3>{title}</h3>
    <ul role="list" className="run-children">{list.map((c) => <li key={c.id}>
      <Link href={runHref(c.id)} scroll={false}>{c.workflow}</Link><StatusBadge status={c.status} /><span className="muted"><When at={c.startedAt} /></span>
    </li>)}</ul>
  </section>;
  return (
    <aside className="run-panel" aria-label="Run details">
      <div className="dialog-head">
        <h2>{run?.workflow ?? "Run"}</h2>
        <button ref={button} type="button" className="icon-button" aria-label="Close run details" onClick={close}>×</button>
      </div>
      <Status state={state} />
      {d && run && <>
        <p><StatusBadge status={run.status} /></p>
        <Reason run={run} links={links} full />
        <dl className="facts">
          <div><dt>Started</dt><dd>{time(run.startedAt)}</dd></div>
          <div><dt>Duration</dt><dd className="numeric"><Duration run={run} /></dd></div>
          <div><dt>How it started</dt><dd>{TRIGGERS[run.trigger] ?? run.trigger}</dd></div>
          <div><dt>Cost</dt><dd className="numeric">{run.unmetered && !run.costUsd ? "On your own plan, not priced" : run.calls ? `${usd(run.costUsd)} · ${run.calls} ${run.calls === 1 ? "call" : "calls"}` : null}</dd></div>
          {note && <div className="wide"><dt>Approval</dt><dd>{note}{run.approvalNote && <p className="muted">{run.approvalNote}</p>}</dd></div>}
          <div className="wide"><dt>Run</dt><dd className="mono">{run.id}</dd></div>
        </dl>
        {d.result && <section>
          <div className="dialog-head"><h3>Result</h3><button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
          <pre className="run-result" tabIndex={0}>{d.result}</pre>
        </section>}
        {others("Started by", d.parent ? [d.parent] : [])}
        {others("Runs it started", d.children)}
        <p className="run-links">
          <Link href={`/workflows/${encodeURIComponent(run.workflow)}`}>Open workflow</Link>
          {trace && <a href={trace} target="_blank" rel="noopener noreferrer">Technical trace ↗</a>}
        </p>
      </>}
    </aside>
  );
}

/** Every run the ledger recorded, or one workflow's, running ones first, then newest first, 50 a page. Polls every 3 s while a shown run goes. */
export function RunsView({ workflow, manifest }: { workflow?: string; manifest: Manifest }) {
  const { params: p, href, go } = useQuery(), links = useLinks(manifest);
  const query = new URLSearchParams();
  for (const k of ["workflow", "q", "status", "period", "before"]) {
    const v = k === "workflow" ? (workflow ?? p.get(k)) : workflow && k === "q" ? null : p.get(k);
    if (v) query.set(k, v);
  }
  const state = useApi<Runs>(`ledger/runs?${query}`, (d) => (d.data.some((r) => isActive(r.status)) ? 3000 : 15_000));
  const names = useApi<{ workflows: { name: string }[] }>(workflow ? null : "workflows").data?.workflows ?? [];
  const d = state.data, filter = (k: string, v: string) => go({ [k]: v || undefined, before: undefined });
  const all = d && traceLink(d), open = p.get("run"), runHref = (id: string) => href({ run: id });
  const filters = ["status", "period", ...(workflow ? [] : ["workflow"])], on = filters.filter((k) => p.get(k)).length;
  const narrowed = on > 0 || query.has("q") || query.has("before");
  const rows = d ? [...d.data].sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status))) : [];
  const columns: Column<Run>[] = [
    { head: workflow ? "Run" : "Workflow", cell: (r) => <>
      <Link href={runHref(r.id)} scroll={false} className={workflow ? "mono" : undefined} aria-current={open === r.id ? "true" : undefined}>{workflow ? r.id.slice(0, 8) : r.workflow}</Link>
      {!workflow && <div className="muted mono" title={r.id}>{r.trigger === "external" ? "Started outside Revbound" : r.id.slice(0, 8)}</div>}
    </> },
    { head: "Status", top: true, cell: (r) => <><StatusBadge status={r.status} />{approval(r) && <div className="muted" title={r.approvalNote ?? undefined}>{approval(r)}</div>}</> },
    { head: "Started", cell: (r) => <When at={r.startedAt} /> },
    { head: "Duration", numeric: true, cell: (r) => <Duration run={r} /> },
    { head: "Cost", numeric: true, title: d?.local ? "Local runs on your own plan aren't priced" : undefined, cell: (r) => <Cost run={r} /> },
  ];
  return <>
    {!workflow && <PageHeader title="Runs" />}
    <section className="pane runs" aria-label="Runs">
      <Toolbar state={state} active={on}
        search={!workflow && <Search label="Search runs" value={p.get("q") ?? ""} onChange={(q) => go({ q: q || undefined, before: undefined }, true)} />}
        filters={<>
          {!workflow && <select name="workflow" aria-label="Filter runs by workflow" value={p.get("workflow") ?? ""} onChange={(e) => filter("workflow", e.target.value)}>
            <option value="">All workflows</option>
            {names.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </select>}
          <select name="status" aria-label="Filter runs by status" value={p.get("status") ?? ""} onChange={(e) => filter("status", e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map(([value, word]) => <option key={value} value={value}>{word}</option>)}
          </select>
          <select name="period" aria-label="Filter runs by time" value={p.get("period") ?? ""} onChange={(e) => filter("period", e.target.value)}>
            <option value="">All time</option>
            <option value="day">Past day</option>
            <option value="week">Past week</option>
            <option value="month">Past month</option>
          </select>
        </>}>
        {all && <a className="button wide-only" href={all} target="_blank" rel="noopener noreferrer">Technical traces ↗</a>}
      </Toolbar>
      <Status state={state} />
      <div className="runs-body">
        {d && <div className="runs-list">
          <div className="table-scroll">
            {rows.length ? <DataTable label="Runs" columns={columns} rows={rows} id={(r) => r.id} clickable note={(r) => r.reason && r.status !== "completed" ? <Reason run={r} links={links} /> : null} />
              : <EmptyState action={narrowed && <Link className="button" href={href(Object.fromEntries([...filters, "q", "before"].map((k) => [k, undefined])))}>Show all runs</Link>}>
                {narrowed ? "No matching runs." : "No runs yet."}</EmptyState>}
          </div>
          <nav className="pagination" aria-label="Run pages">
            {p.has("before") && <Link href={href({ before: undefined })}>Newest</Link>}
            {d.next && <Link href={href({ before: d.next })}>Older runs</Link>}
          </nav>
        </div>}
        {open && <RunPanel key={open} id={open} links={links} runHref={runHref} close={() => go({ run: undefined })} />}
      </div>
    </section>
  </>;
}

export default function RunsPage({ manifest }: ViewProps) {
  return <RunsView manifest={manifest} />;
}

/** A workflow's Runs tab. */
export function RunsTab({ workflow, manifest }: TabProps) {
  return <RunsView workflow={workflow.name} manifest={manifest} />;
}
