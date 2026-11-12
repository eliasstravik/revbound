"use client";
import { Fragment, useEffect } from "react";
import { byGroup, Count, cronWords, EmptyState, glyphs, Icon, isActive, Link, Menu, needsLook, PageHeader, Search, Status, StatusBadge, statusOf, Toolbar, usd, useApi, useQuery, When,
  type TabProps, type ViewProps, type WorkflowInfo } from "revbound/ui";
import { DiagramView } from "./diagram.js";
import "./workflows.css";

type LastRun = { id: string; status: string; startedAt: string; finishedAt: string | null; reason: string | null };
type Workflow = WorkflowInfo & { lastRun: LastRun | null };
type Workflows = { workflows: Workflow[]; runsKnown: boolean };
type Keys = { connections: { name: string; state: string; reserved?: boolean; usedBy: { workflows: string[] } }[] };

/** A workflow's schedules in words (the API joins its crons with "; "), each with its UTC time as tooltip. */
const Schedule = ({ cron }: { cron: string }) => <>{cron.split("; ").map((c, i) => {
  const words = cronWords(c);
  return <Fragment key={c}>{i > 0 && " · "}<span title={words.title}>{words.text}</span></Fragment>;
})}</>;

/** How many of the keys a workflow uses are missing, by workflow, when the project has Connections. */
function useMissing(on: boolean) {
  const keys = useApi<Keys>(on ? "connections" : null, () => 30_000).data?.connections ?? [];
  return (name: string) => keys.filter((c) => c.state === "missing" && !c.reserved && c.usedBy.workflows.includes(name)).length;
}
const hasView = (manifest: ViewProps["manifest"], path: string) => manifest.views.some((v) => v.path === path);
const keysMissing = (n: number) => `${n} ${n === 1 ? "key" : "keys"} missing`;

/** Workflows by group (numbered when they run in steps; the rest by what needs a look first): what each does, its last run, schedule and needs. */
export function WorkflowsView({ manifest }: ViewProps) {
  const state = useApi<Workflows>("workflows", (d) => (d.workflows.some((w) => isActive(w.lastRun?.status)) ? 5000 : 30_000));
  const { params, go } = useQuery(), missing = useMissing(hasView(manifest, "connections"));
  const search = params.get("q") ?? "", failingOnly = params.get("filter") === "failing";
  const all = state.data?.workflows ?? [], known = state.data?.runsKnown ?? false;
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const text = (w: Workflow) => [w.name, w.group, w.description, ...(w.tables ?? []), ...(w.connections ?? [])].join(" ").toLowerCase();
  const failing = (w: Workflow) => needsLook(w.lastRun?.status);
  const rank = (w: Workflow) => (failing(w) ? 0 : missing(w.name) ? 1 : isActive(w.lastRun?.status) ? 2 : 3);
  const sections = byGroup(all).map((s) => ({ ...s, items: s.items.filter((w) => (!failingOnly || failing(w)) && words.every((word) => text(w).includes(word))) }))
    .filter((s) => s.items.length), grouped = all.some((w) => w.group);
  const row = (w: Workflow, steps: boolean) => {
    const n = missing(w.name);
    return <li key={w.name} className="wf-row" data-step={w.step}>{steps && <span className="wf-step" aria-hidden="true">{w.step}</span>}
      <div className="wf-main">
        <p className="wf-name">
          <Link className="wf-link" href={`/workflows/${encodeURIComponent(w.name)}${failing(w) ? "?view=runs" : ""}`}>{w.step != null && <span className="sr-only">Step {w.step}: </span>}{w.name}</Link>
          {n > 0 && <span className="badge" data-tone="failed">{keysMissing(n)}</span>}
          {w.approval?.required && <span className="badge">Needs approval</span>}
        </p>
        {w.description && <p className="wf-description">{w.description}</p>}
      </div>
      <div className="wf-side">
        {w.lastRun ? <p><StatusBadge status={w.lastRun.status} /> <span className="muted"><When at={w.lastRun.startedAt} /></span></p> : known && <p className="muted">Never run</p>}
        {w.cron && <p className="muted"><Schedule cron={w.cron} /></p>}
      </div>
    </li>;
  };
  // "/" jumps to the search, as on most list pages; typing in a field is left alone.
  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const input = document.querySelector<HTMLInputElement>(".toolbar input[type=search]");
      if (input) { e.preventDefault(); input.focus(); }
    };
    addEventListener("keydown", focus);
    return () => removeEventListener("keydown", focus);
  }, []);
  return <>
    <PageHeader title="Workflows" />
    {all.length > 0 && <Toolbar state={state} active={Number(failingOnly)}
      search={<Search label="Search workflows" value={search} onChange={(q) => go({ q: q || undefined }, true)} />}
      filters={<button type="button" aria-pressed={failingOnly} onClick={() => go({ filter: failingOnly ? undefined : "failing" }, true)}>
        Failing{known && <span className="chip-count">{all.filter(failing).length}</span>}
      </button>} />}
    <div className="page">
      <Status state={state} />
      {state.data && !known && all.length > 0 && <p role="status" className="notice">
        Last runs are unavailable. <button type="button" onClick={state.reload}>Retry</button>
      </p>}
      {state.data && (sections.length ? sections.map((s) => {
        const bad = s.items.filter(failing).length, title = s.group ?? "Other";
        const rows = <ul key={title} role="list" className="wf-rows" aria-label={grouped ? title : "Workflows"} data-steps={s.steps || undefined}>
          {(s.group ? s.items : [...s.items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))).map((w) => row(w, s.steps))}
        </ul>;
        return grouped ? <section key={title} className="wf-group">
          <h2>{title}<span className="wf-count">{s.items.length}</span>{bad > 0 && <span className="badge" data-tone="failed">{bad} failing</span>}</h2>{rows}
        </section> : rows;
      }) : <EmptyState action={all.length > 0 && <button type="button" onClick={() => go({ q: undefined, filter: undefined }, true)}>Show all workflows</button>}>
        {all.length ? "No matching workflows." : "No workflows yet. Ask your agent to build one."}
      </EmptyState>)}
    </div>
  </>;
}

/** A workflow's group: its name and its workflows in their order, each with its last run as a dot and this one marked. */
function GroupNav({ w, all, view }: { w: Workflow; all: Workflow[]; view?: string }) {
  const g = byGroup(all).find((s) => s.group === w.group);
  useEffect(() => { document.querySelector(".wf-chain [aria-current]")?.scrollIntoView({ block: "nearest", inline: "center" }); }, [w.name, !g]);
  if (!w.group || !g) return null;
  return <nav className="wf-chain" aria-label={w.group} data-steps={g.steps || undefined}>
    <p>{w.group}</p>
    <ol role="list">{g.items.map((s) => <li key={s.name}>
      <Link href={`/workflows/${encodeURIComponent(s.name)}${view ? `?view=${view}` : ""}`} aria-current={s.name === w.name ? "page" : undefined}>
        {s.step != null && <span className="wf-chain-step"><span className="sr-only">Step </span>{s.step}</span>}{s.name}
        {s.lastRun && <span className="status" data-tone={statusOf(s.lastRun.status).tone} title={statusOf(s.lastRun.status).word}><span className="sr-only">{statusOf(s.lastRun.status).word}</span></span>}
      </Link>
    </li>)}</ol>
  </nav>;
}

/** What every tab of a workflow shows on top: its group, what it does, its last run, when it starts, and what each run needs and may spend. */
function WorkflowHeader({ w, all, view, missing, local }: { w: Workflow; all: Workflow[]; view?: string; missing: number; local: boolean }) {
  const b = w.budget, budget = [b?.perRunUsd != null && `${usd(b.perRunUsd)} per run`, b?.perMonthUsd != null && `${usd(b.perMonthUsd)} per month`].filter(Boolean).join(" · ");
  const runs = `/workflows/${encodeURIComponent(w.name)}?view=runs`;
  return (
    <div className="wf-header">
      <GroupNav w={w} all={all} view={view} />
      {w.description && <p className="wf-about">{w.description}</p>}
      <ul role="list" className="wf-facts">
        <li>{w.lastRun ? <Link href={`${runs}&run=${w.lastRun.id}`}><StatusBadge status={w.lastRun.status} /> <span className="muted"><When at={w.lastRun.startedAt} /></span></Link> : <span className="muted">Never run</span>}</li>
        <li className="muted">{w.cron ? <><Schedule cron={w.cron} />{local && " · Schedules only run in production"}</> : "Starts when asked"}</li>
        {w.approval?.required && <li><span className="badge" title={w.schedule ? `Its schedule is approved until ${w.schedule.approvedUntil}` : undefined}>Needs approval</span></li>}
        {missing > 0 && <li><Link className="badge" data-tone="failed" href={`/workflows/${encodeURIComponent(w.name)}?view=connections`}>{keysMissing(missing)}</Link></li>}
        {budget && <li className="muted">Up to {budget}</li>}
      </ul>
    </div>
  );
}

/**
 * One workflow in its tabs (`?view=`): every plugin's workflow tab in its order (Diagram, Runs, Data, Connections by
 * default; no Diagram tab without a diagram), under a header every tab shares. The path arrives still encoded.
 */
export function WorkflowView({ params, manifest, tabs }: ViewProps) {
  let name = params.name;
  try { name = decodeURIComponent(name); } catch {}
  const state = useApi<Workflows>("workflows", () => 30_000), { params: query } = useQuery(), missing = useMissing(hasView(manifest, "connections"));
  const local = useApi<{ environment: string }>("shell").data?.environment === "local";
  const w = state.data?.workflows.find((x) => x.name === name);
  const list = [...manifest.tabs].filter((t) => tabs[t.id] && (t.id !== "diagram" || w?.diagram)).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const view = list.some((t) => t.id === query.get("view")) ? query.get("view")! : list[0]?.id;
  const Tab = view ? tabs[view] : undefined, path = `/workflows/${encodeURIComponent(name)}`;
  const copy = () => w?.file && navigator.clipboard.writeText(w.file).catch(() => prompt("Copy the file path", w.file!));
  return <>
    <PageHeader title={name} crumb={{ href: "/workflows", label: "Workflows" }}>
      {w && hasView(manifest, "chat") && <Link className="button primary" href={`/chat?draft=${encodeURIComponent(`${w.approval?.required ? "Preview" : "Run"} ${name}`)}`}>Run in Chat</Link>}
      {w && (w.sourceUrl || w.file) && <Menu label="More actions" className="icon-button" trigger={<Icon d={glyphs.more} />}>
        {w.sourceUrl ? <a role="menuitem" href={w.sourceUrl} target="_blank" rel="noopener noreferrer">View source ↗</a>
          : <button type="button" role="menuitem" onClick={copy}>Copy file path</button>}
      </Menu>}
    </PageHeader>
    <Status state={state} />
    {state.data && !w && <EmptyState action={<Link className="button" href="/workflows">All workflows</Link>}>No workflow called {name}.</EmptyState>}
    {w && <>
      <WorkflowHeader w={w} all={state.data!.workflows} view={query.get("view") ?? undefined} missing={missing(w.name)} local={local} />
      <nav className="tabs" aria-label="Workflow views">
        {list.map((t) => <Link key={t.id} href={`${path}?view=${t.id}`} aria-current={view === t.id ? "page" : undefined}>
          {t.title}{t.count && <Count path={`${t.count}?workflow=${encodeURIComponent(name)}`} className="tab-count" />}
        </Link>)}
      </nav>
      {Tab && <Tab workflow={w} manifest={manifest} />}
    </>}
  </>;
}

/** The Diagram tab: the workflow's steps in business terms. */
export function DiagramTab({ workflow: w }: TabProps) {
  return <DiagramView diagram={w.diagram} />;
}
