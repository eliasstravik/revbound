"use client";
import { useEffect, useRef, useState } from "react";
import type { About } from "revbound";

type Diagram = NonNullable<About["diagram"]>;
type Node = Diagram["nodes"][number];
const W = 240, H = 56, GAP_X = 48, GAP_Y = 36, PAD = 24, MIN_FIT = 0.85, STEP = 0.15;

/**
 * Top to bottom in layers: each box one layer below the lowest box that leads to it (a loop stops after one pass per
 * box), boxes in a layer ordered under their sources, every layer centred. `order` is the boxes layer by layer.
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
  return { at, order: rows.flat(), width: width + 2 * PAD, height: rows.length * (H + GAP_Y) - GAP_Y + 2 * PAD };
}

/** A step's explanation and its details. */
const Details = ({ node }: { node: Node }) => <>
  {node.explanation && <p>{node.explanation}</p>}
  {node.details && <dl>{Object.entries(node.details).filter(([, v]) => v).map(([k, v]) =>
    <div key={k}><dt>{k[0].toUpperCase() + k.slice(1)}</dt><dd>{v}</dd></div>)}</dl>}
</>;

/**
 * A workflow's diagram, written by the agent: what it does in business terms. It fits the canvas both ways (never
 * below 85%, then it scrolls), with −, + and Fit; a box opens its explanation in a column beside the canvas. Below
 * 640px the same steps are a list, each opening in place.
 */
export function DiagramView({ diagram }: { diagram?: Diagram }) {
  const [selected, setSelected] = useState<string | null>(null), origin = useRef<HTMLElement | null>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) close.current?.focus(); }, [selected]);
  const node = diagram?.nodes.find((n) => n.id === selected), byId = new Map(diagram?.nodes.map((n) => [n.id, n]));
  const dismiss = () => { setSelected(null); requestAnimationFrame(() => origin.current?.focus()); };
  const g = diagram?.nodes.length ? layout(diagram) : null, canvas = useRef<HTMLDivElement>(null), [fit, setFit] = useState(1), [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || !g) return;
    const ro = new ResizeObserver(() => el.clientWidth && setFit(Math.max(MIN_FIT, Math.min(1, el.clientWidth / g.width, el.clientHeight / g.height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [g?.width, g?.height]);
  if (!g) return <section className="pane diagram-pane" aria-label="Diagram"><p className="notice">No diagram yet. Ask your agent to add one.</p></section>;
  const scale = zoom ?? fit, step = (by: number) => setZoom(Math.round(Math.max(0.5, Math.min(1.5, scale + by)) * 100) / 100);
  return (
    <section className="pane diagram-pane" aria-label="Diagram">
      <div className="diagram-body" data-open={node ? "" : undefined}>
        <div className="diagram-canvas" ref={canvas}>
          <div className="diagram" style={{ width: g.width, height: g.height, zoom: scale }}>
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
              <button key={n.id} type="button" className="business-node" data-kind={n.kind ?? "action"} style={{ left: g.at(n.id)!.x, top: g.at(n.id)!.y }} title={n.label}
                aria-pressed={selected === n.id} onClick={(e) => { origin.current = e.currentTarget; setSelected(n.id); }}>
                <span className="node-kind">{n.kind ?? "action"}</span><span className="node-label">{n.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="diagram-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={scale <= 0.5} onClick={() => step(-STEP)}>−</button>
          <button type="button" aria-label="Zoom in" disabled={scale >= 1.5} onClick={() => step(STEP)}>+</button>
          <button type="button" disabled={zoom === null} onClick={() => setZoom(null)}>Fit</button>
        </div>
        {node && (
          <aside className="node-details" aria-label={node.label} onKeyDown={(e) => e.key === "Escape" && dismiss()}>
            <div className="dialog-head"><h2>{node.label}</h2><button ref={close} type="button" className="icon-button" aria-label="Close details" onClick={dismiss}>×</button></div>
            <Details node={node} />
          </aside>
        )}
        <ol role="list" className="diagram-list">
          {g.order.map((id) => {
            const n = byId.get(id)!, open = selected === id, next = diagram!.edges.filter((e) => e.source === id && e.label && byId.has(e.target));
            return <li key={id} data-kind={n.kind ?? "action"}>
              <button type="button" aria-expanded={open} onClick={() => setSelected(open ? null : id)}><span className="node-kind">{n.kind ?? "action"}</span><span className="node-label">{n.label}</span></button>
              {open && <div className="node-about"><Details node={n} /></div>}
              {next.map((e, i) => <p key={i} className="node-branch">If {e.label} → {byId.get(e.target)!.label}</p>)}
            </li>;
          })}
        </ol>
      </div>
    </section>
  );
}
