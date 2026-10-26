"use client";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { api, glyphs, Icon, Link, Menu, Status, useApi, vercelUrl } from "revbound/ui";
import "./connections.css";

type State = "set" | "missing" | "saved" | "provided" | "readonly";
type Action = "save" | "rename" | "delete";
type Connection = { name: string; label: string; state: State; actions: Action[]; usedBy: { workflows: string[]; plugins: string[] }; shell?: boolean; reserved?: boolean };
type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; csrf?: string };
type Data = { connections: Connection[]; environment: string; save: Save; tokenWarning: string | null; listError: string | null; usageComplete: boolean };
type Done = { ok: true; status: string; redeploy?: "started" | "skipped" | "failed"; shell?: boolean };
type Open = { kind: "add" | "edit" | "delete"; c?: Connection };

/** Heroicons 16 solid: check-circle, x-circle, clock, lock-closed. */
const icons = {
  set: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z",
  missing: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z",
  saved: "M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z",
  readonly: "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
};
const LABELS: Record<State, string> = { set: "Set", missing: "Missing", saved: "Saved, not live yet", provided: "Provided by Vercel", readonly: "Read only" };
const labelOf = (c: Connection) => c.label || c.name;

/** Up to three workflow links (to each one's Connections tab), then "and N more". */
const workflowLinks = (ids: string[]) => <>{ids.slice(0, 3).map((id, i) => <Fragment key={id}>{i ? ", " : ""}
  <Link href={`/workflows/${encodeURIComponent(id)}?view=connections`}>{id}</Link></Fragment>)}{ids.length > 3 ? ` and ${ids.length - 3} more` : ""}</>;
const post = (body: object, csrf?: string) => api<Done>("connections/change", { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(csrf && { "x-revbound-csrf": csrf }) } });

/**
 * Connections: every key by its label, whether it is set here (never its value) and what uses it. Add, Edit and Delete
 * work on this computer, and hosted on the production domain, which then redeploys.
 */
export function ConnectionsView({ only }: { only?: string[] | null }) {
  const state = useApi<Data>("connections", () => 15_000), { data, reload } = state;
  const [open, setOpen] = useState<Open | null>(null), [note, setNote] = useState(""), [retry, setRetry] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    // Leaving the page drops the form and what was typed in it.
    const hide = () => setOpen(null);
    addEventListener("pagehide", hide);
    return () => removeEventListener("pagehide", hide);
  }, []);
  if (!data) return <Status state={state} />;
  const { save } = data, local = data.environment === "local", canChange = save.mode === "local" || save.mode === "hosted";
  const rows = only !== undefined ? data.connections.filter((c) => only?.includes(c.name)) : data.connections, n = rows.length;
  const where = local ? "on this computer" : data.environment === "preview" ? "in Preview" : "in Production";
  const missing = rows.filter((c) => c.state === "missing").length;
  const summary = only === null ? "This workflow doesn't list the keys it uses yet." : only && !only.length ? "This workflow uses no keys."
    : !n ? (only ? "None of the keys this workflow uses is listed yet." : canChange ? "No connections yet. Add your first key, or ask your agent to." : "No connections yet. Ask your agent to add one.")
    : missing ? `${missing} of ${n} ${n === 1 ? "key isn't" : "keys aren't"} set ${where}.`
    : `Every key ${only ? "this workflow uses " : ""}is set ${where}.`;
  const settings = local ? null : vercelUrl("/settings/environment-variables", "Environment Variables");
  const how = (c: Connection) => <>Add it in Vercel: <code>vercel env add {c.name} production</code>, then redeploy</>;
  const done = (kind: Open["kind"], name: string, r: Done) => {
    setOpen(null); reload();
    setRetry(r.redeploy === "failed" || r.redeploy === "skipped" ? r.status : "");
    if (r.shell && kind !== "delete") setNote(`Saved, but your shell sets ${name} too, and that value wins. Unset it in your shell and restart revbound dev to use this one.`);
    else setNote(local || r.redeploy === "failed" || r.redeploy === "skipped" ? "" : r.status);
  };
  async function redeploy() {
    setBusy(true);
    await post({ action: "redeploy" }, save.csrf).then((r) => { setRetry(r.redeploy === "failed" || r.redeploy === "skipped" ? r.status : ""); setNote(r.redeploy === "started" ? r.status : ""); },
      (err: Error) => setRetry(err.message));
    setBusy(false);
  }
  const add = canChange && <button type="button" className="primary" onClick={() => { setNote(""); setOpen({ kind: "add" }); }}>Add connection</button>;
  const vercel = settings && <a className="button" href={settings} target="_blank" rel="noreferrer">Open in Vercel ↗</a>;
  return (
    <div className="connections-view">
      {only !== undefined ? <div className="title-row"><p role="status">{summary}</p><span className="actions">{vercel}<Link className="button" href="/connections">All connections</Link></span></div> : <>
        <div className="title-row">
          <h1>Connections</h1>
          <div className="connection-actions">
            <button type="button" className="icon-button" aria-label="Refresh connections" title="Refresh connections" onClick={reload}><Icon d={glyphs.refresh} /></button>
            {vercel}{add}
          </div>
        </div>
        <p className="subtitle" role="status">{summary}</p>
      </>}
      <div className="page">
        <Status state={state} />
        {only === null && <p className="notice">Ask your agent to list the keys this workflow uses.</p>}
        {data.tokenWarning && <p className="banner warn">{data.tokenWarning}</p>}
        {save.mode === "off" && save.reason && <p className="banner">{save.reason}</p>}
        {data.listError && <p className="banner warn">{data.listError}</p>}
        {retry && <div className="banner warn retry" role="alert"><span>{retry}</span>
          {save.mode === "hosted" && <button type="button" disabled={busy} onClick={redeploy}>{busy ? "Redeploying…" : "Redeploy"}</button>}</div>}
        {note && <p className="banner" role="status">{note}</p>}
        {n > 0 && <div className="connection-list">
          {rows.map((c) => {
            const label = labelOf(c), edit = c.actions.includes("save") || c.actions.includes("rename"), del = c.actions.includes("delete");
            const start = (kind: Open["kind"]) => { setNote(""); setOpen({ kind, c }); };
            return (
              <div className="connection-row" key={c.name}>
                <div className="connection-name">
                  <h3>{label}</h3>
                  {c.label && <p className="muted connection-variable">{c.name}</p>}
                  {!only && (c.usedBy.workflows.length ? <p className="muted connection-usage">{c.state === "missing" ? "Needed by" : "Used by"} {workflowLinks(c.usedBy.workflows)}</p>
                    : c.usedBy.plugins.length ? <p className="muted connection-usage">Used by the {c.usedBy.plugins.join(", ")} plugin{c.usedBy.plugins.length > 1 ? "s" : ""}</p>
                    : data.usageComplete && <p className="muted connection-usage">Not used by any workflow</p>)}
                  {c.shell && <p className="connection-usage connection-shell">Also set in your shell, which overrides it</p>}
                  {c.reserved && c.state !== "provided" && <p className="muted connection-usage">Set with the vendor's CLI or integration, not here</p>}
                  {c.state === "missing" && !local && !canChange && !c.reserved && <p className="muted connection-usage">{how(c)}</p>}
                </div>
                <span className="connection-state" data-state={c.state} title={c.state === "readonly" ? "Shared with other environments or owned by Vercel or an integration: change it in Vercel" : undefined}>
                  <Icon d={icons[c.state === "provided" ? "set" : c.state]} />{LABELS[c.state]}
                </span>
                <div className="connection-buttons">
                  {c.state === "missing" && c.actions.includes("save") && <button type="button" className="primary" aria-label={`Add ${label}`} onClick={() => start("add")}>Add</button>}
                  {(edit || del || settings) && <Menu label={`Actions for ${label}`} className="icon-button" trigger={<Icon d={glyphs.more} />}>
                    {edit && <button type="button" role="menuitem" onClick={() => start("edit")}>Edit</button>}
                    {del && <button type="button" role="menuitem" className="danger-text" onClick={() => start("delete")}>Delete</button>}
                    {settings && <a role="menuitem" href={settings} target="_blank" rel="noreferrer">Open in Vercel ↗</a>}
                  </Menu>}
                </div>
              </div>
            );
          })}
        </div>}
      </div>
      {open && <ConnectionDialog {...open} local={local} csrf={save.csrf} existing={data.connections} close={() => setOpen(null)}
        done={(name, r) => done(open.kind, name, r)} />}
    </div>
  );
}

/**
 * Add, Edit or Delete one connection in a modal. A value is sent once and never shown again; Edit with no value only
 * renames. Escape or Cancel closes it unless it is sending.
 */
function ConnectionDialog({ kind, c, local, csrf, existing, close, done }: Open & { local: boolean; csrf?: string; existing: Connection[];
  close: () => void; done: (name: string, r: Done) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [label, setLabel] = useState(c?.label ?? ""), [name, setName] = useState(c?.name ?? ""), [value, setValue] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    // A typed value never outlives the form: cleared on pagehide (before the back/forward cache keeps the page) and on close.
    const clear = () => { setValue(""); if (input.current) input.current.value = ""; };
    addEventListener("pagehide", clear);
    return () => { removeEventListener("pagehide", clear); clear(); };
  }, []);
  const renames = kind === "edit" && c!.actions.includes("rename"), changed = value !== "" || (renames && label.trim() !== c!.label);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError("");
    const key = name.trim(), there = existing.find((x) => x.name === key);
    if (kind === "add" && !c && there && there.state !== "missing") return setError(`${key} already exists. Close this and use Edit on its row.`);
    setBusy(true);
    const body = kind === "delete" ? { action: "delete", name: key } : value ? { action: "save", name: key, value, label: label.trim() } : { action: "rename", name: key, label: label.trim() };
    await post(body, csrf).then((r) => { setValue(""); done(key, r); }, (err: Error) => { setError(err.message); setBusy(false); });
  }
  const used = c?.usedBy.workflows ?? [];
  return (
    <dialog ref={dialog} className="connection-dialog" aria-labelledby="connection-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit} autoComplete="off">
        <h2 id="connection-title">{kind === "delete" ? `Delete ${labelOf(c!)}?` : kind === "edit" ? "Edit connection" : "Add connection"}</h2>
        {kind === "delete" ? <>
          <p className="connection-warning">{used.length ? <>Used by {workflowLinks(used)}. {used.length === 1 ? "It stops" : "They stop"} working until the key is added again.</>
            : "No workflow lists it as used."}</p>
          {!local && <p className="muted">Production redeploys without it.</p>}
        </> : <div className="connection-fields">
          <label htmlFor="connection-label">Name</label>
          <input id="connection-label" name="label" placeholder="Apollo" maxLength={256} required={kind === "add" || renames} disabled={kind === "edit" && !renames}
            autoFocus={!c} value={label} onChange={(e) => setLabel(e.target.value)} />
          <label htmlFor="connection-key">Key</label>
          <input id="connection-key" name="key" placeholder="APOLLO_API_KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={256} required spellCheck={false}
            readOnly={Boolean(c)} title="Letters, digits and _, not starting with a digit" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} />
          <label htmlFor="connection-value">{kind === "edit" ? "New value" : "Value"}</label>
          <input ref={input} id="connection-value" name="value" type="password" autoComplete="new-password" spellCheck={false} maxLength={32_768} required={!renames}
            className={renames ? undefined : "secret"} autoFocus={Boolean(c)} placeholder={renames ? "Leave empty to keep the current value" : "apk_7f3k9q2m"}
            value={value} onChange={(e) => setValue(e.target.value)} />
        </div>}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className={`primary connection-submit${kind === "delete" ? " danger" : ""}`} disabled={busy || (kind === "edit" && !changed)} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? (kind === "delete" ? "Deleting…" : "Saving…") : kind === "delete" ? "Delete connection" : "Save connection"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function ConnectionsPage() {
  return <ConnectionsView />;
}
