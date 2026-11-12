"use client";
import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { clock, Link, time, useApi } from "./load.js";
import { glyphs, Icon } from "./menu.js";
import { ago, statusOf } from "./words.js";

/** A time as "12m ago"; the full date is its tooltip. */
export const When = ({ at }: { at: string | number }) => <time dateTime={new Date(at).toISOString()} title={time(at)}>{ago(at)}</time>;

/** A run's status, the same everywhere: a dot and its word. */
export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const { word, tone } = statusOf(status);
  return <span className="status" data-tone={tone}>{word}{children}</span>;
}

/** A page's top: an optional way back, the title, a line under it, and its actions on the right. */
export function PageHeader({ title, crumb, subtitle, children }: { title: string; crumb?: { href: string; label: string }; subtitle?: ReactNode; children?: ReactNode }) {
  return <>
    <header className="title-row">
      <div className="breadcrumbs">{crumb && <><Link href={crumb.href}>{crumb.label}</Link><span aria-hidden="true">/</span></>}<h1>{title}</h1></div>
      {children && <div className="actions">{children}</div>}
    </header>
    {subtitle && <p className="subtitle" role="status">{subtitle}</p>}
  </>;
}

type Reloads = { reload: () => void; at?: number };
/** The one refresh control: an icon whose tooltip says when the page last updated. */
export const Refresh = ({ state }: { state: Reloads }) => (
  <button type="button" className="icon-button" aria-label="Refresh" title={state.at ? `Updated ${clock(state.at)}` : "Refresh"} onClick={state.reload}><Icon d={glyphs.refresh} /></button>
);

/** A list's controls: search first, then its filters (behind one Filter button on a phone, with how many are on), then actions and refresh. */
export function Toolbar({ search, filters, active = 0, state, children }: { search?: ReactNode; filters?: ReactNode; active?: number; state?: Reloads; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="toolbar">
      {search}
      {filters && <button type="button" className="toolbar-filter" aria-expanded={open} onClick={() => setOpen(!open)}>
        Filter{active > 0 && <span className="chip-count">{active}</span>}
      </button>}
      {filters && <div className="toolbar-filters" data-open={open || undefined}>{filters}</div>}
      <div className="toolbar-actions">{children}{state && <Refresh state={state} />}</div>
    </div>
  );
}

/** Nothing to show: one line saying what is missing, and at most one action. */
export const EmptyState = ({ children, action }: { children: ReactNode; action?: ReactNode }) => <div className="empty"><p>{children}</p>{action}</div>;

/** `top` cells sit beside the first one on a phone's card; `title` is the heading's tooltip. A cell that returns nothing reads as a dash. */
export type Column<T> = { head: string; cell: (row: T) => ReactNode; numeric?: boolean; top?: boolean; title?: string; className?: string };

/**
 * The Console's one table: horizontal rules only, and below 640px each row is a card (first cell, `top` cells beside
 * it, the rest on one line under it). `note` is a full-width line under a row. With `clickable` the whole row opens
 * the first link in it.
 */
export function DataTable<T>({ label, columns, rows, id, note, clickable, className }: {
  label: string; columns: Column<T>[]; rows: T[]; id: (row: T) => string; note?: (row: T) => ReactNode; clickable?: boolean; className?: string }) {
  const open = (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as Element).closest("a, button, summary") || getSelection()?.toString()) return;
    const row = e.currentTarget;
    (row.classList.contains("row-note") ? row.previousElementSibling : row)?.querySelector<HTMLAnchorElement>("a")?.click();
  };
  return (
    <table className={`data-table${className ? ` ${className}` : ""}`} aria-label={label}>
      <thead><tr>
        {columns.map((c) => <th key={c.head} scope="col" className={c.numeric ? "numeric" : undefined} title={c.title}>{c.head}</th>)}
        {clickable && <th className="chevron"><span className="sr-only">Open</span></th>}
      </tr></thead>
      <tbody>{rows.map((r) => {
        const extra = note?.(r), rowClass = [clickable && "clickable", extra && "has-note"].filter(Boolean).join(" ") || undefined;
        return <Fragment key={id(r)}>
          <tr className={rowClass} onClick={clickable ? open : undefined}>
            {columns.map((c, i) => <td key={c.head} className={[c.numeric && "numeric", c.top && "top", c.className].filter(Boolean).join(" ") || undefined}>
              {c.cell(r)}
              {i === 0 && <div className="card-meta">{columns.slice(1).filter((x) => !x.top).map((x) => <span key={x.head}>{x.cell(r)}</span>)}</div>}
            </td>)}
            {clickable && <td className="chevron" aria-hidden="true">›</td>}
          </tr>
          {extra && <tr className={clickable ? "row-note clickable" : "row-note"} onClick={clickable ? open : undefined}><td colSpan={columns.length + (clickable ? 1 : 0)}>{extra}</td></tr>}
        </Fragment>;
      })}</tbody>
    </table>
  );
}

const COUNTS = "revbound-counts";
/** Reads every count badge again now, after a change that moves one. */
export const refreshCounts = () => dispatchEvent(new Event(COUNTS));
/** A nav item's or a tab's badge: the count its route answers, when above zero. */
export function Count({ path, className }: { path: string; className: string }) {
  const { data, reload } = useApi<{ count: number }>(path, () => 30_000);
  useEffect(() => { addEventListener(COUNTS, reload); return () => removeEventListener(COUNTS, reload); }, [reload]);
  const n = data?.count ?? 0;
  if (!n) return null;
  return <span className={className} title={`${n} need attention`}><span className="sr-only">, </span>{n}<span className="sr-only"> need attention</span></span>;
}
