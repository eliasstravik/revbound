"use client";
import { useEffect, useState } from "react";
import { Link, Search, Status, useApi, useQuery, type TabProps, type ViewProps, type WorkflowInfo } from "revbound/ui";
import { DiagramView } from "./diagram.js";
import "./workflows.css";

type LastRun = { id: string; status: string; createdAt: string; completedAt: string | null };
type Workflow = WorkflowInfo & { lastRun: LastRun | null };
type Workflows = { workflows: Workflow[]; runsKnown: boolean };

const active = (run?: { status: string } | null) => run?.status === "pending" || run?.status === "running";
const WORDS: Record<string, string> = { pending: "queued" };

function ago(value: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000), minutes = Math.round(seconds / 60);
  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A Vercel Cron expression (UTC) in words when it is a plain daily or weekly time; otherwise the expression itself. */
function cronText(cron: string) {
  const [minute, hour, day, month, weekday, ...rest] = cron.trim().split(/\s+/);
  const at = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC` : undefined;
  if (!rest.length && at && day === "*" && month === "*") {
    if (weekday === "*") return `Daily ${at}`;
    if (/^[0-6]$/.test(weekday)) return `${DAYS[Number(weekday)]} ${at}`;
    if (weekday === "1-5") return `Weekdays ${at}`;
  }
  return `Cron ${cron}`;
}
/** The API joins a workflow's crons with "; ". */
const scheduleText = (schedule: string | null) => schedule?.split("; ").map(cronText).join(" · ");

/** The last run's status as a dot before the name; its time is in the tooltip, the history on the workflow's page. */
function Dot({ run, known }: { run: LastRun | null; known: boolean }) {
  const label = run ? `Last run ${WORDS[run.status] ?? run.status} ${ago(run.createdAt)}` : known ? "Never run" : "";
  return <span className={`wf-dot wf-dot-${run?.status ?? (known ? "never" : "unknown")}`} role={label ? "img" : undefined}
    aria-label={label || undefined} title={label || undefined} />;
}

/** Workflows: the registry, one line each with a dot for its last run. Polls faster while a last run is still going. */
export function WorkflowsView() {
  const state = useApi<Workflows>("workflows", (d) => (d.workflows.some((w) => active(w.lastRun)) ? 5000 : 30_000));
  const { params, href, go } = useQuery();
  const search = params.get("q") ?? "", failingOnly = params.get("filter") === "failing";
  const all = state.data?.workflows ?? [], known = state.data?.runsKnown ?? false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (w: Workflow) => [w.name, w.description, ...(w.tables ?? []), ...(w.connections ?? [])].join(" ").toLowerCase();
  const shown = all.filter((w) => (!failingOnly || w.lastRun?.status === "failed") && words.every((word) => text(w).includes(word)));
  // "/" jumps to the search, as on most list pages; typing in a field is left alone.
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const input = document.querySelector<HTMLInputElement>(".wf-controls input[type=search]");
      if (input) { e.preventDefault(); input.focus(); }
    };
    addEventListener("keydown", focus);
    return () => removeEventListener("keydown", focus);
  }, []);
  return <>
    <div className="title-row wf-title">
      <h1>Workflows</h1>
      {all.length > 0 && <div className="wf-controls">
        <Search label="Search workflows" value={search} onChange={(q) => go({ q: q || undefined }, true)} />
        <button type="button" className="wf-failing" aria-pressed={failingOnly} onClick={() => go({ filter: failingOnly ? undefined : "failing" }, true)}>
          Failing{known && <span className="wf-failing-count">{all.filter((w) => w.lastRun?.status === "failed").length}</span>}
        </button>
      </div>}
    </div>
    <div className="page">
      <Status state={state} />
      {state.data && !known && all.length > 0 && <p role="status" className="notice">
        Last runs are unavailable. <button type="button" onClick={state.reload}>Retry</button>
      </p>}
      {state.data && (shown.length ? <ul role="list" className="wf-rows" aria-label="Workflows">
        {shown.map((w) => <li key={w.name} className="wf-row">
          <Dot run={w.lastRun} known={known} />
          <Link className="wf-link" href={`/workflows/${encodeURIComponent(w.name)}`} title={w.description}>{w.name}</Link>
          {w.cron && <span className="wf-meta">{scheduleText(w.cron)}</span>}
        </li>)}
      </ul> : <p className="notice">
        {all.length ? "No matching workflows. " : "No workflows yet. Ask your agent to build one."}
        {all.length > 0 && <button type="button" onClick={() => go({ q: undefined, filter: undefined }, true)}>Show all</button>}
      </p>)}
    </div>
  </>;
}

/**
 * One workflow in its tabs (`?view=`): every plugin's workflow tab in its order (Diagram, Runs, Data, Connections by
 * default). It opens on the diagram, or on the next tab when it has none. The path arrives still encoded.
 */
export function WorkflowView({ params, manifest, tabs }: ViewProps) {
  let name = params.name;
  try { name = decodeURIComponent(name); } catch {}
  const state = useApi<Workflows>("workflows"), { params: query } = useQuery();
  const w = state.data?.workflows.find((x) => x.name === name);
  const list = [...manifest.tabs].filter((t) => tabs[t.id]).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const fallback = list.find((t) => t.id !== "diagram" || w?.diagram)?.id;
  const view = list.some((t) => t.id === query.get("view")) ? query.get("view")! : fallback;
  const Tab = view ? tabs[view] : undefined;
  return <>
    <div className="title-row">
      <div className="breadcrumbs"><Link href="/workflows">Workflows</Link><span aria-hidden="true">/</span><h1>{name}</h1></div>
    </div>
    <Status state={state} />
    {state.data && !w && <p role="alert" className="notice">This workflow no longer exists. <Link href="/workflows">Show all workflows</Link></p>}
    {w && <>
      <nav className="tabs" aria-label="Workflow views">
        {list.map((t) => <Link key={t.id} href={`/workflows/${encodeURIComponent(name)}?view=${t.id}`} aria-current={view === t.id ? "page" : undefined}>
          {t.title}{t.count && <TabCount path={`${t.count}?workflow=${encodeURIComponent(name)}`} />}
        </Link>)}
      </nav>
      {Tab && <Tab workflow={w} manifest={manifest} />}
    </>}
  </>;
}

/** A tab's badge: the count its route answers for this workflow, when above zero. */
function TabCount({ path }: { path: string }) {
  const n = useApi<{ count: number }>(path, () => 30_000).data?.count ?? 0;
  if (!n) return null;
  return <span className="tab-count" title={`${n} need attention`}><span className="sr-only">, </span>{n}<span className="sr-only"> need attention</span></span>;
}

/** The Diagram tab: what the workflow does, how it starts, and its source file. */
export function DiagramTab({ workflow: w }: TabProps) {
  return <DiagramView diagram={w.diagram} actions={<Source workflow={w} />} summary={<>
    {w.description && <p className="diagram-description">{w.description}</p>}
    <p className="diagram-trigger">Starts: {scheduleText(w.cron) ?? "Manual"}</p>
    {w.approval?.required && <p className="diagram-trigger">Needs a person's yes before each run{w.schedule ? `; its schedule is approved until ${w.schedule.approvedUntil}` : ""}</p>}
  </>} />;
}

/** The workflow's file: on GitHub at the deployed commit when hosted from GitHub, else its path to copy. */
function Source({ workflow: { file, sourceUrl } }: { workflow: WorkflowInfo }) {
  const [copied, setCopied] = useState(false);
  if (sourceUrl) return <a className="button" href={sourceUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>;
  if (!file) return null;
  const copy = () => navigator.clipboard.writeText(file)
    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => prompt("Copy the file path", file));
  return <button type="button" title={file} onClick={copy}>{copied ? "Copied" : "Copy file path"}</button>;
}
