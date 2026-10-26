"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { About } from "revbound";

type Diagram = NonNullable<About["diagram"]>;
const W = 240, H = 88, GAP_X = 64, GAP_Y = 90, PAD = 24;

/**
 * Top to bottom in layers: each box one layer below the lowest box that leads to it (a loop stops after one pass per
 * box), boxes in a layer ordered under their sources, every layer centred.
 */
function layout({ nodes, edges }: Diagram) {
  const rank = new Map(nodes.map((n) => [n.id, 0])), from = (id: string) => edges.filter((e) => e.target === id && rank.has(e.source));
  for (let pass = 0; pass < nodes.length; pass++)
    for (const e of edges) if (rank.has(e.source) && rank.has(e.target) && rank.get(e.target)! <= rank.get(e.source)!) rank.set(e.target, rank.get(e.source)! + 1);
  const rows: string[][] = [], x = new Map<string, number>();
  for (const n of nodes) (rows[rank.get(n.id)!] ??= []).push(n.id);
  const width = Math.max(...rows.filter(Boolean).map((r) => r.length)) * (W + GAP_X) - GAP_X;
  rows.forEach((row) => {
    const under = (id: string) => { const xs = from(id).flatMap((e) => x.get(e.source) ?? []); return xs.length ? xs.reduce((a, b) => a + b) / xs.length : 0; };
    row.sort((a, b) => under(a) - under(b));
    row.forEach((id, i) => x.set(id, PAD + (width - row.length * (W + GAP_X) + GAP_X) / 2 + i * (W + GAP_X)));
  });
  const at = (id: string) => (x.has(id) ? { x: x.get(id)!, y: PAD + rank.get(id)! * (H + GAP_Y) } : undefined);
  return { at, width: width + 2 * PAD, height: rows.length * (H + GAP_Y) - GAP_Y + 2 * PAD };
}

/** A workflow's diagram, written by the agent: what it does in business terms. A box opens its explanation. */
export function DiagramView({ diagram, summary, actions }: { diagram?: Diagram; summary: ReactNode; actions?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null), origin = useRef<HTMLElement | null>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) close.current?.focus(); }, [selected]);
  const node = diagram?.nodes.find((n) => n.id === selected);
  const dismiss = () => { setSelected(null); requestAnimationFrame(() => origin.current?.focus()); };
  const g = diagram?.nodes.length ? layout(diagram) : null, canvas = useRef<HTMLDivElement>(null), [fit, setFit] = useState(1);
  // Like the viewer's "fit view": the whole diagram fits the canvas's width, never larger than life size.
  useEffect(() => {
    const el = canvas.current, width = g?.width;
    if (!el || !width) return;
    const ro = new ResizeObserver(() => setFit(Math.max(0.4, Math.min(1, el.clientWidth / width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [g?.width]);
  return (
    <section className="pane diagram-pane" aria-label="Diagram">
      <div className="diagram-summary"><div>{summary}</div>{actions}</div>
      <div className="diagram-body">
        {!g ? <p className="notice">Diagram unavailable. Ask your agent to add the business diagram.</p> : (
          <div className="diagram-canvas" ref={canvas}>
            <div className="diagram" style={{ width: g.width, height: g.height, zoom: fit }}>
              <svg width={g.width} height={g.height} aria-hidden="true">
                <defs><marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" /></marker></defs>
                {diagram!.edges.map((e, i) => {
                  const a = g.at(e.source), b = g.at(e.target);
                  if (!a || !b) return null;
                  const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H, b.x + W / 2, b.y], mid = (y1 + y2) / 2;
                  return <path key={i} d={`M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`} markerEnd="url(#diagram-arrow)" />;
                })}
              </svg>
              {diagram!.edges.map((e, i) => {
                const a = g.at(e.source), b = g.at(e.target);
                return e.label && a && b ? <span key={i} className="graph-label" style={{ left: (a.x + b.x + W) / 2, top: (a.y + H + b.y) / 2 }}>{e.label}</span> : null;
              })}
              {diagram!.nodes.map((n) => (
                <button key={n.id} type="button" className={`business-node kind-${n.kind ?? "action"}`} style={{ left: g.at(n.id)!.x, top: g.at(n.id)!.y }}
                  aria-pressed={selected === n.id} onClick={(e) => { origin.current = e.currentTarget; setSelected(n.id); }}>
                  <span className="node-kind">{n.kind ?? "action"}</span>{n.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {node && (
          <aside className="node-details" aria-label={node.label} onKeyDown={(e) => e.key === "Escape" && dismiss()}>
            <div className="dialog-head"><h2>{node.label}</h2><button ref={close} type="button" aria-label="Close details" onClick={dismiss}>×</button></div>
            {node.explanation && <p>{node.explanation}</p>}
            {node.details && <dl>{Object.entries(node.details).filter(([, v]) => v).map(([k, v]) =>
              <div key={k}><dt>{k[0].toUpperCase() + k.slice(1)}</dt><dd>{v}</dd></div>)}</dl>}
          </aside>
        )}
      </div>
    </section>
  );
}
