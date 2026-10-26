"use client";
import { useEffect, useState } from "react";
import { api } from "./load.js";

export type Release = { state: "updating" | "live" | "failed"; details?: string };
/** The redeploy a hosted change last started, `{ id, path, at }`, kept in localStorage so every tab follows it, for 15 minutes at most. */
const KEY = "revbound-console-release", SETTLED = "revbound-console-release-settled";
const NAMES: Record<string, string> = { local: "Local", preview: "Preview", production: "Production" };
const following = (): { id: string; path: string } | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return typeof s?.id === "string" && typeof s?.path === "string" && Date.now() - s.at < 15 * 60_000 ? s : null;
  } catch { return null; }
};

/**
 * Called when a hosted change starts a redeploy (`id`, its deployment): every tab's badge turns amber at once and reads
 * `/api/revbound/<path>?id=<id>` → `{ release: Release | null }` until it settles.
 */
export function releaseStarted(id: string, path: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ id, path, at: Date.now() })); } catch { /* This tab still shows it. */ }
  dispatchEvent(new Event(KEY));
}
/** Calls `fn` with "live" or "failed" when the followed redeploy settles; returns the unsubscribe. */
export function onReleaseSettled(fn: (state?: Release["state"]) => void) {
  const on = (e: Event) => fn((e as CustomEvent<Release["state"] | undefined>).detail);
  addEventListener(SETTLED, on);
  return () => removeEventListener(SETTLED, on);
}

/**
 * The followed redeploy's state, one poller for every badge on the page: read every 5 s while it builds, "live" shown
 * for 8 s. `settled` is the id this page has an outcome for (a reload, which a new deployment brings, asks once more).
 */
const badges = new Set<(r: Release | null) => void>();
let release: Release | null = null, timer: ReturnType<typeof setTimeout> | undefined, fade: typeof timer, settled = "";
const show = (r: Release | null) => { release = r; badges.forEach((set) => set(r)); };
async function check() {
  clearTimeout(timer);
  const f = following();
  if (!badges.size || !f || f.id === settled) return release?.state === "updating" && show(null);
  show({ state: "updating" });
  const next = await api<{ release: Release | null }>(`${f.path}?id=${encodeURIComponent(f.id)}`).then((r) => r.release, () => undefined);
  if (following()?.id !== f.id) return;
  if (next === undefined || next?.state === "updating") return void (timer = setTimeout(check, 5000));
  settled = f.id; clearTimeout(fade); show(next); dispatchEvent(new CustomEvent(SETTLED, { detail: next?.state }));
  if (next?.state === "live") fade = setTimeout(() => show(null), 8000);
}
if (typeof window !== "undefined") { addEventListener(KEY, check); addEventListener("storage", (e) => e.key === KEY && check()); }
function useRelease(on: boolean): Release | null {
  const [state, setState] = useState(release);
  useEffect(() => {
    if (!on) return;
    badges.add(setState);
    if (badges.size === 1) check(); else setState(release);
    return () => void badges.delete(setState);
  }, [on]);
  return on ? state : null;
}

/** Local, Preview or Production; Production also says whether a change saved in the console is live yet. */
export function EnvironmentBadge({ environment }: { environment: string }) {
  const r = useRelease(environment === "production"), state = r?.state;
  const kind = NAMES[environment] ? environment : "preview", name = NAMES[kind];
  return (
    <span className="environment-badge" data-environment={kind} data-state={state} role="status"
      title={state === "updating" ? "Production: your change goes live in about a minute" : kind === "local" ? "The console on this computer" : `Hosted on Vercel (${name})`}>
      {state ? <span><span className="badge-name">{name} · </span>{state === "updating" ? "Updating…" : state === "live" ? "Your change is live" : "Update failed"}</span> : name}
      {state === "updating" && <span className="badge-more">live in about a minute</span>}
      {r?.details && <a href={r.details} target="_blank" rel="noreferrer">Details</a>}
    </span>
  );
}
