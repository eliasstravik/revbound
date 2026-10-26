"use client";
import { Fragment } from "react";
import { Icon, Link, Status, useApi, vercelUrl } from "revbound/ui";
import "./connections.css";

type State = "set" | "missing" | "provided";
type Connection = { name: string; label: string; state: State; usedBy: { workflows: string[]; plugins: string[] }; shell?: boolean };
type Data = { connections: Connection[]; environment: string; usageComplete: boolean };

/** Heroicons 16 solid: check-circle, x-circle. */
const icons = {
  set: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z",
  missing: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z",
};
const LABELS: Record<State, string> = { set: "Set", missing: "Missing", provided: "Provided by Vercel" };

/** Up to three workflow links (to each one's Connections tab), then "and N more". */
const workflowLinks = (ids: string[]) => <>{ids.slice(0, 3).map((id, i) => <Fragment key={id}>{i ? ", " : ""}
  <Link href={`/workflows/${encodeURIComponent(id)}?view=connections`}>{id}</Link></Fragment>)}{ids.length > 3 ? ` and ${ids.length - 3} more` : ""}</>;

/** Connections: every key by its label, whether it is set here (never its value) and what uses it. Read-only. */
export function ConnectionsView({ only }: { only?: string[] | null }) {
  const state = useApi<Data>("connections", () => 15_000), data = state.data;
  if (!data) return <Status state={state} />;
  const local = data.environment === "local";
  const rows = only !== undefined ? data.connections.filter((c) => only?.includes(c.name)) : data.connections, n = rows.length;
  const where = local ? "on this computer" : data.environment === "preview" ? "in Preview" : "in Production";
  const missing = rows.filter((c) => c.state === "missing").length;
  const summary = only === null ? "This workflow doesn't list the keys it uses yet." : only && !only.length ? "This workflow uses no keys."
    : !n ? (only ? "None of the keys this workflow uses is listed yet." : "No connections yet. Ask your agent to add one.")
    : missing ? `${missing} of ${n} ${n === 1 ? "key isn't" : "keys aren't"} set ${where}.`
    : `Every key ${only ? "this workflow uses " : ""}is set ${where}.`;
  const settings = local ? null : vercelUrl("/settings/environment-variables", "Environment Variables");
  const vercel = settings && <a className="button" href={settings} target="_blank" rel="noreferrer">Open in Vercel ↗</a>;
  const how = (c: Connection) => local ? <>Set it with <code>npx revbound connections set {c.name}</code></>
    : <>Add it in Vercel: <code>vercel env add {c.name} production</code>, then redeploy</>;
  return (
    <div className="connections-view">
      {only !== undefined ? <div className="title-row"><p role="status">{summary}</p><span className="actions">{vercel}<Link className="button" href="/connections">All connections</Link></span></div> : <>
        <div className="title-row"><h1>Connections</h1>{vercel}</div>
        <p className="subtitle" role="status">{summary}</p>
      </>}
      <div className="page">
        <Status state={state} />
        {only === null && <p className="notice">Ask your agent to list the keys this workflow uses.</p>}
        {n > 0 && <div className="connection-list">
          {rows.map((c) => (
            <div className="connection-row" key={c.name}>
              <div className="connection-name">
                <h3>{c.label || c.name}</h3>
                {c.label && <p className="muted connection-variable">{c.name}</p>}
                {!only && (c.usedBy.workflows.length ? <p className="muted connection-usage">{c.state === "missing" ? "Needed by" : "Used by"} {workflowLinks(c.usedBy.workflows)}</p>
                  : c.usedBy.plugins.length ? <p className="muted connection-usage">Used by the {c.usedBy.plugins.join(", ")} plugin{c.usedBy.plugins.length > 1 ? "s" : ""}</p>
                  : data.usageComplete && <p className="muted connection-usage">Not used by any workflow</p>)}
                {c.shell && <p className="connection-usage connection-shell">Also set in your shell, which overrides it</p>}
                {c.state === "missing" && <p className="muted connection-usage">{how(c)}</p>}
              </div>
              <span className="connection-state" data-state={c.state}><Icon d={icons[c.state === "provided" ? "set" : c.state]} />{LABELS[c.state]}</span>
              {settings && <a className="connection-open" href={settings} target="_blank" rel="noreferrer" aria-label={`Open ${c.name} in Vercel`}>Open in Vercel ↗</a>}
            </div>
          ))}
        </div>}
      </div>
    </div>
  );
}

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
