"use client";
import NextLink from "next/link.js";
import { usePathname, useRouter, useSearchParams } from "next/navigation.js";
import { useCallback, useEffect, useRef, useState } from "react";

/** next/link is CommonJS: under NodeNext its default import is typed as the module, but bundlers hand over the component. */
export const Link = NextLink as unknown as typeof NextLink.default;

/** The address of `/api/revbound/<path>` under the app's base path. */
export const apiUrl = (path: string) => `${process.env.__NEXT_ROUTER_BASEPATH ?? ""}/api/revbound/${path}`;

/** A page of this project in Vercel's dashboard: Vercel's `/d` link, which asks for the team and project (`path` after them). */
export const vercelUrl = (path: string, title: string) =>
  `https://vercel.com/d?to=${encodeURIComponent(`/[team]/[project]${path}`)}&title=${encodeURIComponent(title)}`;

/** Calls `/api/revbound/<path>`; throws the API's `{ error }` text (or the HTTP status) on failure. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: "no-store", ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok || body == null) throw new Error(body?.error ?? `${res.status} ${res.statusText}`.trim());
  return body as T;
}

/** Polling stops after half an hour without input, and while the tab is hidden; touching or showing the page reads at once. */
const IDLE_MS = 30 * 60_000;
let lastInput = Date.now();
const wakers = new Set<() => void>();
if (typeof window !== "undefined") {
  const awake = () => {
    const idle = Date.now() - lastInput >= IDLE_MS;
    lastInput = Date.now();
    if (idle) wakers.forEach((fn) => fn());
  };
  for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(name, awake, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => document.hidden || wakers.forEach((fn) => fn()));
}

type State<T> = { key?: string; data?: T; error?: string; at?: number };

/**
 * Reads `/api/revbound/<path>` (nothing while path is null), again on `reload()`, and, when `every` gives a delay for the
 * last result, after that delay. One read at a time, timed from the last answer, so a slow one is never cut off; a
 * failure retries with backoff up to a minute. The last data stays shown while a new read is in flight.
 */
export function useApi<T>(path: string | null, every?: (data: T) => number | undefined) {
  const [s, set] = useState<State<T>>({});
  const [tick, setTick] = useState(0);
  const delay = useRef(every);
  delay.current = every;
  useEffect(() => {
    if (path == null) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, busy = false, failures = 0;
    const read = async () => {
      clearTimeout(timer);
      if (busy || ctrl.signal.aborted) return;
      busy = true;
      let next: number | undefined;
      try {
        const data = await api<T>(path, { signal: ctrl.signal });
        failures = 0;
        set({ key: path, data, at: Date.now() });
        next = delay.current?.(data);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        set((p) => ({ ...(p.key === path ? p : {}), key: path, error: (e as Error).message }));
        next = Math.min(3000 * 2 ** failures++, 60_000);
      } finally {
        busy = false;
      }
      if (next !== undefined && !ctrl.signal.aborted) timer = setTimeout(() => !document.hidden && Date.now() - lastInput < IDLE_MS && read(), next);
    };
    const wake = () => !document.hidden && read();
    wakers.add(wake);
    read();
    return () => { ctrl.abort(); clearTimeout(timer); wakers.delete(wake); };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const same = path != null && s.key === path;
  return { data: same ? s.data : undefined, error: same ? s.error : undefined, at: s.at, loading: path != null && !same, reload };
}

export const time = (value: string | number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

/** Run length. Under ten seconds keeps a tenth, so a quick run never reads as 0s. */
export function duration(ms: number) {
  if (ms < 10_000) return `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

/** A view's loading line, or its error with Retry (and, when older data is still shown, how old it is). */
export function Status({ state }: { state: { loading: boolean; error?: string; data?: unknown; at?: number; reload: () => void } }) {
  if (state.loading && !state.error) return <p role="status" className="notice">Loading…</p>;
  if (!state.error) return null;
  return (
    <p role="alert" className="notice error">
      {state.data !== undefined && state.at ? `Showing data from ${time(state.at)}. ` : ""}
      {state.error} <button type="button" onClick={state.reload}>Retry</button>
    </p>
  );
}

/**
 * The query string as state: `params` now, `href(changes)` for a link that changes some of it (undefined removes a
 * name), and `go(changes, replace)` to navigate there without scrolling to the top.
 */
export function useQuery() {
  const params = useSearchParams(), pathname = usePathname(), router = useRouter();
  const href = (changes: Record<string, string | undefined>, path = pathname) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) v === undefined ? p.delete(k) : p.set(k, v);
    return p.size ? `${path}?${p}` : path;
  };
  const go = (changes: Record<string, string | undefined>, replace = false) =>
    (replace ? router.replace : router.push)(href(changes), { scroll: false });
  return { params, href, go };
}

/** A search field that reports its text a quarter second after typing stops. */
export function Search({ value, onChange, label = "Search" }: { value: string; onChange: (value: string) => void; label?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), 250);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);
  return <input type="search" name="search" aria-label={label} placeholder={label} value={text} onChange={(e) => setText(e.target.value)} />;
}
