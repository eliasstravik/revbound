"use client";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ColumnChooser } from "./column-chooser.js";
import { api, apiUrl, glyphs, Icon, Menu, Search, Status, time, useApi, useQuery } from "revbound/ui";
import "./data.css";

type Page = { table: string; fields: { name: string; type: string }[]; columns: string[]; pinned: string | null; rows: unknown[][]; offset: number; total: number };
type Database = { mode: "local" | "none" } | { mode: "link"; url: string | null; label: string; title: string };

/** Columns that carry a verdict: the grid shows them right after the name. */
const SCORE = /(^|_)(score|verdict|priority|tier|fit|grade|rating)$/i;
const FILTERS = ["q", "field", "operator", "value", "sort", "order", "columns"];
const OPERATORS = { eq: "Equals", ne: "Does not equal", gt: "Greater than", lt: "Less than", missing: "Is missing" };
const label = (name: string) => name.replaceAll("_", " ");
const text = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Complete web addresses only (a bare domain gets https://); emails, prose and other schemes stay text. */
function webUrl(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "", absolute = /^https?:\/\//i.test(s);
  if (!s || /[\s\x00-\x1f\x7f\\]/.test(s) || (!absolute && !/^[^/:?#@]+\.[^/:?#@]+(?:[/:?#]|$)/.test(s))) return;
  try {
    const url = new URL(absolute ? s : `https://${s}`), labels = url.hostname.split(".");
    if (url.username || url.password) return;
    const host = labels.every((l) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(l)) && /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(labels.at(-1)!);
    return absolute || host ? url.href : undefined;
  } catch {
    return;
  }
}

function CellValue({ value }: { value: unknown }): ReactNode {
  if (value !== null && typeof value === "object") return (
    <details className="structured-value">
      <summary>{Array.isArray(value) ? `${value.length} ${value.length === 1 ? "entry" : "entries"}` : "View details"}</summary>
      <Structured value={value} />
    </details>
  );
  const url = webUrl(value);
  if (url) return <a className="cell-link" href={url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-label={`${text(value)} (opens in a new tab)`}>{text(value)}</a>;
  return value == null ? <span className="muted">NULL</span> : text(value);
}

/** A JSON value as nested lists: arrays numbered (an object entry titled by its name), objects as labelled fields. */
function Structured({ value }: { value: unknown }): ReactNode {
  const nested = (v: unknown, summary: string) =>
    v && typeof v === "object" ? <details><summary>{summary}</summary><Structured value={v} /></details> : <CellValue value={v} />;
  if (Array.isArray(value)) return (
    <ol>{value.map((item, i) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return <li key={i}>{nested(item, [o.title ?? o.name ?? o.school_name, o.company_name].filter(Boolean).join(" · ") || `Entry ${i + 1}`)}</li>;
    })}</ol>
  );
  if (value && typeof value === "object") return (
    <dl>{Object.entries(value).filter(([, v]) => v != null).map(([k, v]) => <Fragment key={k}><dt>{label(k)}</dt><dd>{nested(v, "Details")}</dd></Fragment>)}</dl>
  );
  return <CellValue value={value} />;
}

const ROW = 37, OVERSCAN = 10, SETTLE_MS = 120;

/**
 * The whole table as one scrolling list, without pages: the list is as tall as the matching rows, only rows near the
 * screen are drawn, and once the scroll rests the window read (and re-read every 15 s) moves to cover the screen.
 * Rows read before stay until the count changes; rows not read yet show as placeholders.
 */
function useRows(view: string | null, box: RefObject<HTMLDivElement | null>) {
  const [screen, setScreen] = useState({ first: 0, last: 30 }), [layout, relayout] = useState(0);
  const [win, setWin] = useState({ view, offset: 0, limit: 60 });
  const at = win.view === view ? win : { view, offset: 0, limit: 60 };
  const state = useApi<Page>(view && `${view}offset=${at.offset}&limit=${at.limit}`, () => 15_000);
  const s = useRef({ view: null as string | null, page: undefined as Page | undefined, rows: new Map<number, unknown[]>(), heights: new Map<number, number>() }).current;
  const p = state.data;
  if (p && p !== s.page) {
    if (s.view !== view || s.page?.total !== p.total) { s.rows.clear(); s.heights.clear(); }
    Object.assign(s, { view, page: p });
    p.rows.forEach((r, i) => s.rows.set(p.offset + i, r));
  }
  const total = s.page?.total ?? 0, fresh = s.view === view;
  // Where each row starts: drawn rows keep their measured height (an open JSON value is taller), the rest the estimate.
  const starts = useMemo(() => {
    const out = new Float64Array(total + 1);
    for (let i = 0; i < total; i++) out[i + 1] = out[i] + (s.heights.get(i) ?? ROW);
    return out;
  }, [total, layout, s.page]);
  const indexAt = (y: number) => {
    let lo = 0, hi = total;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return Math.min(lo, Math.max(0, total - 1));
  };
  const head = () => box.current?.querySelector("thead")?.getBoundingClientRect().height ?? ROW;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const first = indexAt(Math.max(0, el.scrollTop - head())), last = indexAt(el.scrollTop + el.clientHeight - head());
      setScreen((o) => (o.first === first && o.last === last ? o : { first, last }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => { el.removeEventListener("scroll", measure); ro.disconnect(); };
  });
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = 0; }, [view]);
  useLayoutEffect(() => {
    let moved = false;
    for (const tr of box.current?.querySelectorAll<HTMLElement>("tr[data-index]") ?? []) {
      const i = Number(tr.dataset.index), h = tr.getBoundingClientRect().height;
      if (h && Math.abs((s.heights.get(i) ?? ROW) - h) > 0.5) { s.heights.set(i, h); moved = true; }
    }
    if (moved) relayout((n) => n + 1);
  });
  // Waiting for the scroll to rest means dragging the scrollbar across a table reads nothing on the way.
  useEffect(() => {
    if (!fresh) return;
    const timer = setTimeout(() => {
      const from = Math.max(0, screen.first - OVERSCAN), to = Math.min(total, screen.last + 1 + OVERSCAN);
      const limit = Math.min(200, Math.max(60, 2 * (to - from)));
      // Centred on the screen, so a short move either way stays inside the window.
      if (from < at.offset || to > at.offset + at.limit) setWin({ view, offset: Math.max(0, from - ((limit - to + from) >> 1)), limit });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [screen.first, screen.last, view, total, fresh]);
  const start = Math.max(0, screen.first - OVERSCAN), end = Math.min(total, screen.last + 1 + OVERSCAN);
  return {
    state, page: s.page, rows: s.rows, fresh, total, start, end, before: starts[start], after: starts[total] - starts[end],
    /** Brings a row on screen, for keyboard movement past the drawn rows. */
    reveal(i: number) {
      const el = box.current!;
      if (starts[i] < el.scrollTop) el.scrollTop = starts[i];
      else if (starts[i + 1] + head() > el.scrollTop + el.clientHeight) el.scrollTop = starts[i + 1] + head() - el.clientHeight;
    },
  };
}

/** Data: any table (or only a workflow's `tables`) as a read-only grid, with search, one filter, sort, column choice and export. */
export function DataView({ tables: only }: { tables?: string[] }) {
  const { params, go } = useQuery();
  const tables = useApi<{ tables: { name: string }[] }>("data"), database = useApi<Database>("database").data;
  const names = tables.data?.tables.map((t) => t.name).filter((n) => !only || only.includes(n)) ?? [];
  const table = params.get("table") ?? names[0];
  const filters = new URLSearchParams(FILTERS.flatMap((k) => (params.has(k) ? [[k, params.get(k)!]] : [])));
  const view = table ? `data/${encodeURIComponent(table)}?${filters}${filters.size ? "&" : ""}` : null;
  const box = useRef<HTMLDivElement>(null), grid = useRef<HTMLTableElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const list = useRows(view, box), page = list.page;
  // A read that fails (say, a bad filter value in a link) still gets the toolbar, from a plain read, to fix it in place.
  const bare = useApi<Page>(list.state.error && !page && table ? `data/${encodeURIComponent(table)}?limit=1` : null).data, head = page ?? bare;
  const [selected, setSelected] = useState<[number, number] | null>(null), [widths, setWidths] = useState<Record<string, number>>({});
  const [message, setMessage] = useState(""), [exporting, setExporting] = useState(false), [detail, setDetail] = useState<unknown>("");
  const origin = useRef<HTMLElement | null>(null), focusAfterDraw = useRef<[number, number] | null>(null), drag = useRef<{ x: number; w: number } | null>(null);
  useEffect(() => setSelected(null), [view]);
  const cols = page?.columns ?? [], pinned = page?.pinned ? cols.indexOf(page.pinned) : -1;
  // Display order: the name, then scores and verdicts, then the rest, each group in table order. Cells keep their index.
  const rank = (j: number) => (j === pinned ? 0 : SCORE.test(cols[j]) ? 1 : 2);
  const order = cols.map((_, j) => j).sort((a, b) => rank(a) - rank(b));
  const numeric = (j: number) => ["number", "boolean"].includes(page?.fields.find((f) => f.name === cols[j])?.type ?? "");
  const width = (j: number) => widths[cols[j]] ?? (numeric(j) ? 120 : 220);
  const setWidth = (j: number, w: number) => setWidths((o) => ({ ...o, [cols[j]]: Math.max(100, Math.min(800, w)) }));
  const value = (cell: [number, number]) => list.rows.get(cell[0])?.[cell[1]];
  const update = (changes: Record<string, string | undefined>) => { setSelected(null); go(changes); };
  const copy = (v: unknown) =>
    navigator.clipboard.writeText(text(v)).then(() => setMessage("Copied value."), () => setMessage("Copy failed. Select the value and copy it."));
  async function download(format: "csv" | "json") {
    setExporting(true);
    setMessage("");
    try {
      const q = new URLSearchParams(filters);
      q.set("columns", cols.join(","));
      const res = await fetch(apiUrl(`data/${encodeURIComponent(table!)}/${format}?${q}`), { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Export failed: ${res.status}.`);
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: `${table}.${format}` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setMessage(`Export complete at ${time(Date.now())}.${res.headers.get("x-revbound-truncated") ? " It stops at 10,000 rows or 5 MB." : ""}`);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  // Locally: Drizzle Studio on this computer's database. The tab opens first, so no popup blocker stops it.
  async function openDatabase() {
    const tab = window.open("", "_blank");
    setMessage("Opening the database…");
    try {
      const { url } = await api<{ url: string }>("database/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (tab) { tab.opener = null; tab.location.href = url; } else location.assign(url);
      setMessage("");
    } catch (e) {
      tab?.close();
      setMessage((e as Error).message);
    }
  }
  const cellAt = (row: number, column: number) => grid.current?.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`);
  useLayoutEffect(() => {
    const target = focusAfterDraw.current && cellAt(...focusAfterDraw.current);
    if (target) { focusAfterDraw.current = null; target.focus(); }
  });
  function onGridKey(e: KeyboardEvent) {
    if (!selected) return;
    // A key pressed before the last move drew its row moves on from that row, so no press is lost.
    const [row, column] = focusAfterDraw.current ?? selected;
    const at = e.target as HTMLElement, inner = e.key === "Enter" && at.matches('[role="gridcell"]') && at.querySelector<HTMLElement>("a.cell-link, summary");
    if (inner) { e.preventDefault(); inner.click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !getSelection()?.toString()) {
      e.preventDefault();
      copy(value([row, column]));
    }
    const delta = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, number[]>)[e.key];
    if (!delta) return;
    e.preventDefault();
    const to: [number, number] = [Math.max(0, Math.min(list.total - 1, row + delta[0])), order[Math.max(0, Math.min(order.length - 1, order.indexOf(column) + delta[1]))]];
    // Past the drawn rows (or rows not read yet), bring the row on screen and focus its cell once it is drawn.
    const target = cellAt(...to);
    if (target) target.focus();
    else { focusAfterDraw.current = to; list.reveal(to[0]); }
  }
  // The database button, or (`role` menuitem) its entry in the More menu.
  const openDatabaseAs = (className?: string, role?: "menuitem") => database?.mode === "local"
    ? <button type="button" className={className} role={role} onClick={openDatabase}>Open database ↗</button>
    : database?.mode === "link" && database.url ? <a className={role ? undefined : `button ${className}`} role={role} href={database.url}
      target="_blank" rel="noopener noreferrer" title={database.title}>{database.label} ↗</a> : null;
  const exports = <>
    <button type="button" role="menuitem" disabled={exporting || !list.total} onClick={() => download("csv")}>Export CSV</button>
    <button type="button" role="menuitem" disabled={exporting || !list.total} onClick={() => download("json")}>Export JSON</button>
  </>;
  const cell = selected && list.rows.has(selected[0]) ? selected : null, span = cols.length + 1, sort = params.get("sort"), desc = params.get("order") === "desc";
  return (
    <>
      {!only && <div className="title-row"><h1>Data</h1></div>}
      <section className="pane data-pane" aria-label="Data">
        <Status state={!tables.data ? tables : { ...list.state, data: page, loading: !page && list.state.loading }} />
        {/* A new project has no tables yet but still gets the database button. */}
        {tables.data && !names.length && database && <div className="toolbar">{openDatabaseAs("end")}</div>}
        {tables.data && !names.length && <p className="notice">{only ? "No configured data for this workflow." : "No tables yet. Workflow results show up here."}</p>}
        {head && (
          <>
            <div className="toolbar data-toolbar">
              <select name="data-table" aria-label="Data table" value={table}
                onChange={(e) => update({ table: e.target.value, ...Object.fromEntries(FILTERS.map((k) => [k, undefined])) })}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <Search label="Search data" value={params.get("q") ?? ""} onChange={(q) => update({ q: q || undefined })} />
              <select name="filter-field" aria-label="Filter field" value={params.get("field") ?? ""}
                onChange={(e) => update({ field: e.target.value || undefined, value: undefined })}>
                <option value="">Filter</option>
                {head.fields.map((f) => <option key={f.name} value={f.name}>{label(f.name)}</option>)}
              </select>
              {params.has("field") && <select name="filter-operator" aria-label="Filter operator" value={params.get("operator") ?? "eq"}
                onChange={(e) => update({ operator: e.target.value })}>{Object.entries(OPERATORS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
              {params.has("field") && params.get("operator") !== "missing" &&
                <Search label="Filter value" value={params.get("value") ?? ""} onChange={(v) => update({ value: v || undefined })} />}
              {/* Exports and the database fold into More when the row runs out of room (data.css). */}
              <div className="toolbar-actions">
                <button type="button" className="icon-button" aria-label="Refresh" title="Refresh" onClick={list.state.reload}><Icon d={glyphs.refresh} /></button>
                <ColumnChooser key={table} fields={head.fields.map((f) => f.name)} visible={head.columns} onChange={(c) => update({ columns: c?.join(",") })} />
                <Menu label="Export" className="menu-trigger roomy" trigger="Export">{exports}</Menu>
                {openDatabaseAs("roomy")}
                <Menu label="More actions" className="icon-button cramped" trigger={<Icon d={glyphs.more} />}>{exports}{openDatabaseAs(undefined, "menuitem")}</Menu>
              </div>
            </div>
            {page && <><div className="table-scroll" ref={box}>
              <table ref={grid} className="data-grid" role="grid" aria-label={table} aria-readonly="true" aria-rowcount={list.total + 1}
                // An explicit width keeps the layout fixed, so a long value cannot widen its column.
                style={{ width: 56 + order.reduce((sum, j) => sum + width(j), 0) }} aria-busy={!list.fresh} onKeyDown={onGridKey}>
                <colgroup><col style={{ width: 56 }} />{order.map((j) => <col key={cols[j]} style={{ width: width(j) }} />)}</colgroup>
                <thead>
                  <tr aria-rowindex={1}>
                    <th className="row-number" aria-label="Row number">#</th>
                    {order.map((j) => (
                      <th key={cols[j]} scope="col" className={j === pinned ? "pinned" : undefined}
                        aria-sort={sort === cols[j] ? (desc ? "descending" : "ascending") : "none"}>
                        <button type="button" onClick={() => update({ sort: cols[j], order: sort === cols[j] && !desc ? "desc" : "asc" })}>
                          {label(cols[j])} {sort === cols[j] ? (desc ? "↓" : "↑") : ""}
                        </button>
                        <span role="separator" aria-orientation="vertical" aria-label={`Resize ${label(cols[j])}`} aria-valuenow={width(j)}
                          aria-valuemin={100} aria-valuemax={800} tabIndex={0} className="resize-handle"
                          onPointerDown={(e) => { e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: width(j) }; }}
                          onPointerMove={(e) => drag.current && setWidth(j, drag.current.w + e.clientX - drag.current.x)}
                          onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}
                          onKeyDown={(e) => {
                            const step = ({ ArrowLeft: -20, ArrowRight: 20 } as Record<string, number>)[e.key];
                            if (step) { e.preventDefault(); e.stopPropagation(); setWidth(j, width(j) + step); }
                          }} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.before > 0 && <tr className="spacer" aria-hidden="true"><td colSpan={span} style={{ height: list.before }} /></tr>}
                  {Array.from({ length: list.end - list.start }, (_, n) => {
                    const i = list.start + n, row = list.rows.get(i);
                    return (
                      <tr key={i} data-index={i} aria-rowindex={i + 2}>
                        <th scope="row" className="row-number">{i + 1}</th>
                        {!row ? <td colSpan={cols.length} className="muted">Loading…</td> : order.map((j) => (
                          <td key={cols[j]} role="gridcell" className={j === pinned ? "pinned" : undefined} data-row={i} data-column={j}
                            tabIndex={(selected ? selected[0] === i && selected[1] === j : i === 0 && j === order[0]) ? 0 : -1}
                            aria-selected={selected?.[0] === i && selected[1] === j}
                            onClick={(e) => e.currentTarget.focus()}
                            // Only the cell itself selects, so a click on a link inside it finishes first.
                            onFocus={(e) => e.target === e.currentTarget && setSelected([i, j])}>
                            <CellValue value={row[j]} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {list.after > 0 && <tr className="spacer" aria-hidden="true"><td colSpan={span} style={{ height: list.after }} /></tr>}
                </tbody>
              </table>
              {list.fresh && !list.total && <p className="notice">{params.has("q") || params.has("field") ? "No matching records." : "This table is empty."}</p>}
            </div>
            <div className="grid-footer">
              <span className="muted">{!list.fresh ? "Loading…" : `${list.total.toLocaleString()} ${params.has("q") || params.has("field") ? "matching " : ""}${list.total === 1 ? "record" : "records"}`}</span>
              <p className="grid-message" role="status">{message}</p>
              {cell && <div className="grid-cell-actions">
                <button type="button" onClick={() => copy(value(cell))}>Copy cell</button>
                <button type="button" onClick={(e) => { origin.current = e.currentTarget; setDetail(value(cell)); dialog.current?.showModal(); }}>View value</button>
              </div>}
            </div></>}
          </>
        )}
        {!page && <p className="grid-message" role="status">{message}</p>}
        <dialog ref={dialog} className="value-dialog" aria-label="Cell value" onClose={() => origin.current?.focus()}>
          <div className="dialog-head">
            <h2>Cell value</h2>
            <button type="button" aria-label="Close value" onClick={() => dialog.current?.close()}>×</button>
          </div>
          <div className="structured-value value"><Structured value={detail} /></div>
          <div className="dialog-actions"><button type="button" onClick={() => copy(detail)}>Copy value</button></div>
        </dialog>
      </section>
    </>
  );
}

/** The console's Data view. */
export default function DataPage() {
  return <DataView />;
}
