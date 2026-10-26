"use client";
import "@fontsource-variable/geist/index.css";
import "@fontsource-variable/geist-mono/index.css";
import "./style.css";
import { usePathname } from "next/navigation.js";
import { useEffect, useRef, type ReactNode } from "react";
import type { Manifest, ManifestView } from "revbound";
import { find, segments } from "revbound/kit";
import { Link, Status, useApi } from "revbound/ui";

type Info = { company: string; environment: "local" | "preview" | "production"; deployment: string | null };
const NAMES: Record<string, string> = { local: "Local", preview: "Preview", production: "Production" };

/** The console's home: the Context view when a plugin has one, else Workflows, else the first view. */
export function home(views: ManifestView[]): ManifestView | undefined {
  return views.find((v) => v.path === "context") ?? views.find((v) => v.path === "workflows") ?? views[0];
}

/** A nav item's badge: the count its route answers, when above zero. */
function Count({ path }: { path: string }) {
  const n = useApi<{ count: number }>(path, () => 30_000).data?.count ?? 0;
  if (!n) return null;
  return <span className="nav-count" title={`${n} need attention`}><span className="sr-only">, </span>{n}<span className="sr-only"> need attention</span></span>;
}

/**
 * The console's frame: a sidebar with the company, the environment and every view's nav item (in their `order`); below
 * 1024px a top bar whose menu button opens the same items in a modal <dialog>.
 */
export function Shell({ manifest, children }: { manifest: Manifest; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const shell = useApi<Info>("shell", () => 30_000), { data: info, reload } = shell;
  const menu = useRef<HTMLDialogElement>(null), seen = useRef(pathname), deployment = useRef<string | null>(null);
  const items = manifest.views.filter((v) => v.nav).sort((a, b) => a.nav!.order - b.nav!.order);
  const parts = segments(pathname), start = home(manifest.views);
  const view = parts.length ? find(manifest.views, parts)?.item : start;
  // A view's nav item is current on its own paths and on paths below it (workflows/x under Workflows).
  const current = view && (items.find((i) => i.path === view.path) ?? items.find((i) => parts[0] === segments(i.path)[0]));
  useEffect(() => {
    menu.current?.close();
    if (seen.current !== pathname) reload();
    seen.current = pathname;
  }, [pathname, reload]);
  // The tab shows only the company ("Acme"); the html element carries the environment for the local top rule.
  useEffect(() => {
    if (!info) return;
    document.title = info.company;
    document.documentElement.dataset.environment = info.environment;
  }, [info]);
  // A new deployment brings new page code: reload for it, but never under an open dialog or menu (the next read retries).
  useEffect(() => {
    const next = info?.deployment;
    if (!next || next === deployment.current) return;
    if (!deployment.current) deployment.current = next;
    else if (!document.querySelector("dialog[open], [popover]:popover-open")) location.reload();
  }, [info]);
  const kind = info && NAMES[info.environment] ? info.environment : "preview";
  const brand = (
    <div className="brand">
      <Link href="/" className="company">{info?.company ?? manifest.company}</Link>
      {info && <span className="environment-badge" data-environment={kind} role="status"
        title={kind === "local" ? "The console on this computer" : `Hosted on Vercel (${NAMES[kind]})`}>{NAMES[kind]}</span>}
    </div>
  );
  const nav = (
    <nav className="nav" aria-label="Console">
      <ul role="list">
        {items.map((v) => (
          <li key={v.path}>
            <Link href={`/${v.path}`} aria-current={current === v ? "page" : undefined}>
              {v.nav!.label}{v.nav!.count && <Count path={v.nav!.count} />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
  const button = (label: string, d: string, onClick: () => void) => (
    <button type="button" className="icon" aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </button>
  );
  const open = () => { menu.current?.showModal(); menu.current?.querySelector<HTMLElement>(".icon")?.focus(); };
  const close = () => menu.current?.close();
  return (
    <div className="app">
      {/* React hoists it into <head>: links out of the console (Vercel, GitHub, Neon, Studio) never carry its URL. */}
      <meta name="referrer" content="no-referrer" />
      <aside className="sidebar">{brand}{nav}</aside>
      <header className="topbar">{button("Open menu", "M3 6h14M3 10h14M3 14h14", open)}{brand}</header>
      {/* Clicks on the backdrop land on the dialog itself; the panel inside it catches the rest. */}
      <dialog ref={menu} className="drawer" aria-label="Menu" onClick={(e) => (e.target === e.currentTarget || (e.target as Element).closest("a")) && close()}>
        <div className="drawer-panel">
          <div className="drawer-top">{button("Close menu", "M5 5l10 10M15 5L5 15", close)}{brand}</div>
          {nav}
        </div>
      </dialog>
      <main className={view?.fill ? "main fill" : "main"}>
        <Status state={{ ...shell, loading: false }} />
        {children}
      </main>
    </div>
  );
}
