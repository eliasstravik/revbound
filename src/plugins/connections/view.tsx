"use client";
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { api, glyphs, Icon, keyName, Link, Menu, onReleaseSettled, PageHeader, Refresh, refreshCounts, releaseStarted, Status, useApi, vercelUrl } from "revbound/ui";
import "./connections.css";

type State = "set" | "missing" | "saved" | "provided" | "readonly";
type Action = "save" | "rename" | "delete";
type Connection = { name: string; label: string; state: State; actions: Action[]; usedBy: { workflows: string[]; plugins: string[] }; shell?: boolean; reserved?: boolean };
type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; csrf?: string };
type Data = { connections: Connection[]; environment: string; save: Save; tokenWarning: string | null; listError: string | null; settingsUrl: string | null;
  usageComplete: boolean };
type Done = { ok: true; status: string; id?: string; redeploy?: "started" | "skipped" | "failed"; shell?: boolean };
type Open = { kind: "add" | "edit" | "delete"; c?: Connection };

/** Heroicons 16 solid: check-circle, x-circle, clock, lock-closed. */
const icons = {
  set: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm3.844-8.791a.75.75 0 0 0-1.188-.918l-3.7 4.79-1.649-1.833a.75.75 0 1 0-1.114 1.004l2.25 2.5a.75.75 0 0 0 1.15-.043l4.25-5.5Z",
  missing: "M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14Zm2.78-4.22a.75.75 0 0 1-1.06 0L8 9.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L6.94 8 5.22 6.28a.75.75 0 0 1 1.06-1.06L8 6.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L9.06 8l1.72 1.72a.75.75 0 0 1 0 1.06Z",
  saved: "M1 8a7 7 0 1 1 14 0A7 7 0 0 1 1 8Zm7.75-4.25a.75.75 0 0 0-1.5 0V8c0 .414.336.75.75.75h3.25a.75.75 0 0 0 0-1.5h-2.5v-3.5Z",
  readonly: "M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z",
};
const LABELS: Record<State, string> = { set: "Set", missing: "Missing", saved: "Saved, not live yet", provided: "Provided by Vercel", readonly: "Read only" };
/** A key's name on screen: the one a person gave it, else one read from its variable (FIRECRAWL_API_KEY is "Firecrawl"). */
const labelOf = (c: Connection) => c.label || keyName(c.name);
/** A key this page cannot set (an integration or the vendor's own tool sets it): never counted as missing here. */
const elsewhere = (c: Connection) => Boolean(c.reserved) && c.state === "missing";

/** Up to three workflow links (to each one's Connections tab), then "and N more". */
const workflowLinks = (ids: string[]) => <>{ids.slice(0, 3).map((id, i) => <Fragment key={id}>{i ? ", " : ""}
  <Link href={`/workflows/${encodeURIComponent(id)}?view=connections`}>{id}</Link></Fragment>)}{ids.length > 3 ? ` and ${ids.length - 3} more` : ""}</>;
const post = (body: object, csrf?: string) => api<Done>("connections/change", { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(csrf && { "x-revbound-csrf": csrf }) } });

/**
 * Connections: every key by its name, whether it is set here (never its value) and what uses it, in one fixed order.
 * Add, Edit and Delete work on this computer, and hosted on the production domain, which then redeploys.
 */
export function ConnectionsView({ only, chat }: { only?: string[] | null; chat?: boolean }) {
  const state = useApi<Data>("connections", () => 15_000), { data, reload } = state;
  const [open, setOpen] = useState<Open | null>(null), [note, setNote] = useState(""), [retry, setRetry] = useState(""), [busy, setBusy] = useState(false);
  // Keys saved from this page read "going live" until the redeploy the badge follows settles.
  const [saved, setSaved] = useState<string[]>([]), [flash, setFlash] = useState("");
  useEffect(() => onReleaseSettled((s) => {
    setSaved([]); reload(); setNote("");
    if (s === "failed") { setRetry("The redeploy failed, so production still runs without your last change."); }
  }), [reload]);
  useEffect(() => {
    // Leaving the page drops the form and what was typed in it.
    const hide = () => setOpen(null);
    addEventListener("pagehide", hide);
    return () => removeEventListener("pagehide", hide);
  }, []);
  if (!data) return <Status state={state} />;
  const { save } = data, local = data.environment === "local", canChange = save.mode === "local" || save.mode === "hosted";
  const rows = only !== undefined ? data.connections.filter((c) => only?.includes(c.name)) : data.connections, n = rows.length;
  const where = local ? "here (Local)" : data.environment === "preview" ? "in Preview" : "in Production";
  const missing = rows.filter((c) => c.state === "missing" && !c.reserved).length, pending = rows.some((c) => saved.includes(c.name));
  const waiting = rows.filter((c) => c.state === "saved" && !saved.includes(c.name)).length;
  const summary = only === null ? "This workflow doesn't list the keys it uses yet." : only && !only.length ? "This workflow uses no keys."
    : !n ? (only ? "None of the keys this workflow uses is listed yet." : canChange ? "No keys yet. Add your first key, or ask your agent to." : "No keys yet. Ask your agent to add one.")
    : missing ? `${missing} of ${n} ${n === 1 ? "key is" : "keys are"} missing ${where}.`
    : pending ? "Your workflows can use the keys you saved in about a minute."
    : waiting ? `${waiting} saved ${waiting === 1 ? "key isn't" : "keys aren't"} live yet; the next production deployment uses ${waiting === 1 ? "it" : "them"}.`
    : `Every key ${only ? "this workflow uses " : ""}is set ${where}.`;
  const settings = local ? null : data.settingsUrl ?? vercelUrl("/settings/environment-variables", "Environment Variables");
  const follow = (r: Done) => r.id && releaseStarted(r.id, "connections/release");
  const how = (c: Connection) => <>Add it in Vercel: <code>vercel env add {c.name} production</code>, then redeploy</>;
  const done = (kind: Open["kind"], c: { name: string; label: string }, r: Done) => {
    setOpen(null); reload(); refreshCounts(); follow(r);
    if (r.id && kind !== "delete") setSaved((s) => [...s, c.name]);
    setRetry(r.redeploy === "failed" || r.redeploy === "skipped" ? r.status : "");
    setFlash(kind === "delete" ? "" : c.name);
    if (r.shell && kind !== "delete") setNote(`Saved, but your shell sets ${c.name} too, and that value wins. Unset it in your shell and restart revbound dev to use this one.`);
    else setNote(local || r.redeploy ? `${c.label} ${kind === "delete" ? "deleted" : "saved"}.` : r.status);
  };
  async function redeploy() {
    setBusy(true);
    await post({ action: "redeploy" }, save.csrf).then((r) => { follow(r); setRetry(r.redeploy === "failed" || r.redeploy === "skipped" ? r.status : ""); setNote(r.redeploy ? "" : r.status); },
      (err: Error) => setRetry(err.message));
    setBusy(false);
  }
  const add = canChange && <button type="button" className="primary" onClick={() => { setNote(""); setOpen({ kind: "add" }); }}>Add key</button>;
  const vercel = settings && <a className="button" href={settings} target="_blank" rel="noreferrer">Open in Vercel ↗</a>;
  return (
    <div className="connections-view">
      {only !== undefined ? <div className="title-row"><p role="status">{summary}</p><span className="actions">{vercel}<Link className="button" href="/connections">All keys</Link></span></div>
        : <PageHeader title="Connections" subtitle={summary}><Refresh state={state} />{vercel}{add}</PageHeader>}
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
            const label = labelOf(c), del = c.actions.includes("delete"), adds = c.state === "missing" && c.actions.includes("save");
            // Add already edits a missing key, so its menu holds only what Add does not do.
            const edit = !adds && (c.actions.includes("save") || c.actions.includes("rename")), out = elsewhere(c);
            const going = saved.includes(c.name) && (c.state === "set" || c.state === "saved");
            const start = (kind: Open["kind"]) => { setNote(""); setOpen({ kind, c }); };
            return (
              <div className="connection-row" key={c.name} data-flash={flash === c.name ? "" : undefined} onAnimationEnd={() => setFlash("")}>
                <div className="connection-name">
                  <h3>{label}</h3>
                  <p className="muted connection-variable">{c.name}</p>
                  {!only && (c.usedBy.workflows.length ? <p className="muted connection-usage">{c.state === "missing" ? "Needed by" : "Used by"} {workflowLinks(c.usedBy.workflows)}</p>
                    : c.usedBy.plugins.length ? <p className="muted connection-usage">Used by the {c.usedBy.plugins.join(", ")} plugin{c.usedBy.plugins.length > 1 ? "s" : ""}</p>
                    : data.usageComplete && <p className="muted connection-usage">Not used by any workflow</p>)}
                  {c.shell && <p className="connection-usage connection-shell">Also set in your shell, which overrides it</p>}
                  {out && <p className="muted connection-usage">It can't be added on this page. {chat ? "Your agent sets it up with you in Chat." : "Ask your agent to set it up with you."}</p>}
                  {c.state === "missing" && !local && !canChange && !c.reserved && <p className="muted connection-usage">{how(c)}</p>}
                </div>
                <span className="connection-state" data-state={going ? "saved" : out ? "readonly" : c.state} title={c.state === "readonly" ? "Shared with other environments or owned by Vercel or an integration: change it in Vercel" : undefined}>
                  {!out && <Icon d={icons[going ? "saved" : c.state === "provided" ? "set" : c.state]} />}{going ? "Saved, going live" : out ? "Set up elsewhere" : LABELS[c.state]}
                </span>
                <div className="connection-buttons">
                  {adds && <button type="button" aria-label={`Add ${label}`} onClick={() => start("add")}>Add</button>}
                  {out && chat && <Link className="button" href={`/chat?draft=${encodeURIComponent(`Set up ${label}`)}`}>Set up in Chat</Link>}
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
        done={(c, r) => done(open.kind, c, r)} />}
    </div>
  );
}

type Errors = { label?: string; key?: string; value?: string; form?: string };

/**
 * Add, Edit or Delete one key in a modal. Adding a listed key starts with its name filled in and the value ready to
 * paste. A value is sent once and never shown again; Edit with no value only renames. What is wrong is said under
 * its field. Escape or Cancel closes it unless it is sending.
 */
function ConnectionDialog({ kind, c, local, csrf, existing, close, done }: Open & { local: boolean; csrf?: string; existing: Connection[];
  close: () => void; done: (c: { name: string; label: string }, r: Done) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), [busy, setBusy] = useState(false), [errors, setErrors] = useState<Errors>({});
  const [label, setLabel] = useState(c ? labelOf(c) : ""), [name, setName] = useState(c?.name ?? ""), [value, setValue] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    // A typed value never outlives the form: cleared on pagehide (before the back/forward cache keeps the page) and on close.
    const clear = () => { setValue(""); if (input.current) input.current.value = ""; };
    addEventListener("pagehide", clear);
    return () => { removeEventListener("pagehide", clear); clear(); };
  }, []);
  const renames = kind === "edit" && c!.actions.includes("rename"), changed = value !== "" || (renames && label.trim() !== c!.label);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const key = name.trim(), there = existing.find((x) => x.name === key), wrong: Errors = {};
    if (kind !== "delete") {
      if ((kind === "add" || renames) && !label.trim()) wrong.label = "Give it a name, like the service it is for.";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) wrong.key = "Use letters, digits and _, not starting with a digit.";
      else if (kind === "add" && !c && there && there.state !== "missing") wrong.key = `${key} already exists. Close this and use Edit on its row.`;
      if (!value && !renames) wrong.value = "Paste the key.";
    }
    setErrors(wrong);
    if (Object.keys(wrong).length) return void dialog.current?.querySelector<HTMLElement>("[aria-invalid=true]")?.focus();
    setBusy(true);
    const body = kind === "delete" ? { action: "delete", name: key } : value ? { action: "save", name: key, value, label: label.trim() } : { action: "rename", name: key, label: label.trim() };
    await post(body, csrf).then((r) => { setValue(""); done({ name: key, label: label.trim() || keyName(key) }, r); }, (err: Error) => { setErrors({ form: err.message }); setBusy(false); });
  }
  const used = c?.usedBy.workflows ?? [], title = c ? labelOf(c) : "";
  const wrong = (field: keyof Errors) => errors[field] && <p id={`connection-${field}-error`} role="alert" className="error field-error">{errors[field]}</p>;
  const invalid = (field: keyof Errors) => ({ "aria-invalid": errors[field] ? true : undefined, "aria-describedby": errors[field] ? `connection-${field}-error` : undefined });
  return (
    <dialog ref={dialog} className="connection-dialog" aria-labelledby="connection-title" onCancel={(e) => { e.preventDefault(); if (!busy) close(); }}>
      <form onSubmit={submit} autoComplete="off" noValidate>
        <h2 id="connection-title">{kind === "delete" ? `Delete ${title}?` : kind === "edit" ? `Edit ${title} key` : c ? `Add ${title} key` : "Add key"}</h2>
        {kind === "delete" ? <>
          <p className="connection-warning">{used.length ? <>Used by {workflowLinks(used)}. {used.length === 1 ? "It stops" : "They stop"} working until the key is added again.</>
            : "No workflow lists it as used."}</p>
          {!local && <p className="muted">Production redeploys without it.</p>}
        </> : <div className="connection-fields">
          <label htmlFor="connection-label">Name</label>
          <input id="connection-label" name="label" maxLength={256} disabled={kind === "edit" && !renames}
            autoFocus={!c} value={label} onChange={(e) => setLabel(e.target.value)} {...invalid("label")} />
          {wrong("label")}
          {c ? <><span className="field-label">Key</span><p className="mono connection-key">{name}</p></> : <>
            <label htmlFor="connection-key">Key</label>
            <input id="connection-key" name="key" placeholder="SERVICE_API_KEY" maxLength={256} spellCheck={false}
              value={name} onChange={(e) => { setName(e.target.value); setErrors({}); }} {...invalid("key")} />
            {wrong("key")}
          </>}
          <label htmlFor="connection-value">{kind === "edit" ? "New value" : "Value"}</label>
          <input ref={input} id="connection-value" name="value" type="password" autoComplete="new-password" spellCheck={false} maxLength={32_768}
            className={renames ? undefined : "secret"} autoFocus={Boolean(c)} placeholder={renames ? "Leave empty to keep the current value" : "Paste the key"}
            value={value} onChange={(e) => setValue(e.target.value)} {...invalid("value")} />
          {wrong("value")}
        </div>}
        {wrong("form")}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={close}>Cancel</button>
          <button type="submit" className={`primary connection-submit${kind === "delete" ? " danger" : ""}`} disabled={busy || (kind === "edit" && !changed)} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}{busy ? (kind === "delete" ? "Deleting…" : "Saving…") : kind === "delete" ? "Delete key" : "Save key"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function ConnectionsPage({ manifest }: { manifest: { views: { path: string }[] } }) {
  return <ConnectionsView chat={manifest.views.some((v) => v.path === "chat")} />;
}
