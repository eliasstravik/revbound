"use client";
import { useEffect, useState } from "react";
import { apiUrl, duration, Link, Search, Status, time, useApi, useQuery, vercelUrl, type TabProps } from "revbound/ui";
import "./runs.css";

type Run = { id: string; sdkRunId: string | null; workflow: string; trigger: string; preview: boolean; status: string; reason: string | null;
  parentRunId: string | null; rootRunId: string; approvedMaxUsd: number | null; approvalNote: string | null; startedAt: string; finishedAt: string | null;
  costUsd: number; calls: number; unmetered: number };
type Runs = { data: Run[]; hasMore: boolean; next: string | null; local: boolean; environment: string };

const active = (run: { status: string }) => run.status === "admitted" || run.status === "running";
const STATUSES = ["running", "completed", "failed", "refused", "start_failed", "cancelled", "unknown"];
const WORDS: Record<string, string> = { admitted: "starting", start_failed: "didn't start" };
const usd = (n: number) => (n > 0 && n < 0.0001 ? "under $0.0001" : n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** How long a run took, or has taken so far: ticks every second while it runs. */
function Duration({ run }: { run: Run }) {
  const [now, setNow] = useState(Date.now());
  const going = active(run);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => document.hidden || setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [going]);
  if (!run.finishedAt && !going) return <>—</>;
  return <>{duration((run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime())}</>;
}

/** A run's page, or with no run all runs: the local run inspector (only on this computer), or Vercel's dashboard. */
function runLink(d: Runs, sdkRunId?: string | null) {
  if (sdkRunId === null) return null;
  const id = sdkRunId && encodeURIComponent(sdkRunId);
  if (d.local) return typeof location !== "undefined" && ["127.0.0.1", "localhost"].includes(location.hostname)
    ? { href: apiUrl(id ? `inspector/run/${id}` : "inspector"), label: id ? "Open in Workflow ↗" : "All runs in Workflow ↗" } : null;
  return id ? { href: vercelUrl(`/workflows/runs/${id}?environment=${d.environment}`, "Workflow run"), label: "Open in Vercel ↗" }
    : { href: vercelUrl(`/workflows?environment=${d.environment}`, "Workflow runs"), label: "All runs in Vercel ↗" };
}

function Cost({ run }: { run: Run }) {
  if (run.unmetered && !run.costUsd) return <span className="muted" title={`${run.unmetered} call(s) on your own plan`}>plan usage, not metered</span>;
  return <>{run.calls ? usd(run.costUsd) : "—"}</>;
}

function Approval({ run }: { run: Run }) {
  if (run.preview) return <span className="muted">Preview</span>;
  if (run.approvedMaxUsd != null) return <span title={run.approvalNote ?? undefined}>Approved, up to {usd(run.approvedMaxUsd)}</span>;
  if (run.parentRunId) return <span className="muted">Part of a larger run</span>;
  return <span className="muted">—</span>;
}

/** Every run the ledger recorded, or one workflow's, newest first, 50 a page. Polls every 3 s while a shown run goes. */
export function RunsView({ workflow }: { workflow?: string }) {
  const { params: p, href, go } = useQuery();
  const query = new URLSearchParams();
  for (const k of ["workflow", "q", "status", "period", "before"]) {
    const v = k === "workflow" ? (workflow ?? p.get(k)) : workflow && k === "q" ? null : p.get(k);
    if (v) query.set(k, v);
  }
  const state = useApi<Runs>(`ledger/runs?${query}`, (d) => (d.data.some(active) ? 3000 : 15_000));
  const names = useApi<{ workflows: { name: string }[] }>(workflow ? null : "workflows").data?.workflows ?? [];
  const d = state.data, filter = (k: string, v: string) => go({ [k]: v || undefined, before: undefined });
  const all = d && runLink(d);
  const narrowed = ["q", "status", "period", "before", ...(workflow ? [] : ["workflow"])].some((k) => query.has(k));
  return <>
    {!workflow && <div className="title-row"><h1>Runs</h1></div>}
    <section className="pane runs" aria-label="Runs">
      <div className="toolbar">
        {!workflow && <>
          <select name="workflow" aria-label="Filter runs by workflow" value={p.get("workflow") ?? ""} onChange={(e) => filter("workflow", e.target.value)}>
            <option value="">All workflows</option>
            {names.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </select>
          <Search label="Search runs" value={p.get("q") ?? ""} onChange={(q) => go({ q: q || undefined, before: undefined }, true)} />
        </>}
        <select name="status" aria-label="Filter runs by status" value={p.get("status") ?? ""} onChange={(e) => filter("status", e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{(WORDS[s] ?? s)[0].toUpperCase() + (WORDS[s] ?? s).slice(1)}</option>)}
        </select>
        <select name="period" aria-label="Filter runs by time" value={p.get("period") ?? ""} onChange={(e) => filter("period", e.target.value)}>
          <option value="">All time</option>
          <option value="day">Past day</option>
          <option value="week">Past week</option>
          <option value="month">Past month</option>
        </select>
        <button type="button" onClick={state.reload}>Refresh</button>
        {all && <a className="button" href={all.href} target="_blank" rel="noopener noreferrer">{all.label}</a>}
      </div>
      <Status state={state} />
      {d && <>
        <div className="table-scroll">
          <table>
            <thead><tr>{!workflow && <th>Workflow</th>}<th>Started</th><th>Status</th><th>Duration</th><th>Cost</th><th>Approval</th><th>Details</th></tr></thead>
            <tbody>
              {d.data.map((r) => {
                const link = runLink(d, r.sdkRunId);
                return <tr key={r.id}>
                  {!workflow && <td><Link href={`/workflows/${encodeURIComponent(r.workflow)}?view=runs`}>{r.workflow}</Link><div className="muted" title={r.id}>{r.trigger === "external" ? "Started outside Revbound" : r.id.slice(0, 8)}</div></td>}
                  <td><time tabIndex={0} dateTime={r.startedAt} title={new Date(r.startedAt).toString()}>{time(r.startedAt)}</time></td>
                  <td><span className={`status status-${r.status}`}>{WORDS[r.status] ?? r.status}</span></td>
                  <td className="numeric"><Duration run={r} /></td>
                  <td className="numeric"><Cost run={r} /></td>
                  <td><Approval run={r} /></td>
                  <td>
                    {r.reason && r.status !== "completed" && <span className="run-error error" title={r.reason}>{r.reason}</span>}
                    {link && <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>}
                    {!r.reason && !link && <span className="muted">—</span>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
          {!d.data.length && <p className="notice">{narrowed ? "No matching runs." : "No runs yet."}</p>}
        </div>
        <nav className="pagination" aria-label="Run pages">
          {p.has("before") && <Link href={href({ before: undefined })}>Newest</Link>}
          {d.next && <Link href={href({ before: d.next })}>Older runs</Link>}
        </nav>
      </>}
    </section>
  </>;
}

export default function RunsPage() {
  return <RunsView />;
}

/** A workflow's Runs tab. */
export function RunsTab({ workflow }: TabProps) {
  return <RunsView workflow={workflow.name} />;
}
