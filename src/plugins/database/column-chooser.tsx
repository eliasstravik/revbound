"use client";
import { useEffect, useId, useRef, useState } from "react";
import { place } from "revbound/ui";

/** The Columns button and its popover: a draft of checked columns (at least one) applied at once, or Reset to all. */
export function ColumnChooser({ fields, visible, onChange }: { fields: string[]; visible: string[]; onChange: (columns: string[] | undefined) => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [draft, setDraft] = useState(visible);
  const matches = fields.filter((f) => `${f.replaceAll("_", " ")} ${f}`.toLowerCase().includes(query.trim().toLowerCase()));

  const position = () => trigger.current && panel.current && place(trigger.current, panel.current, Math.min(304, innerWidth - 24));
  useEffect(() => {
    if (!open) return;
    addEventListener("resize", position);
    addEventListener("scroll", position, true);
    return () => { removeEventListener("resize", position); removeEventListener("scroll", position, true); };
  }, [open]);
  const close = () => { panel.current?.hidePopover(); trigger.current?.focus(); };

  return (
    <>
      <button type="button" className="columns-trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
        onClick={() => {
          if (panel.current?.matches(":popover-open")) return close();
          setDraft(visible); setQuery("");
          // Placed before showing (no flash at the corner), then again with its real height.
          position(); panel.current?.showPopover(); position(); search.current?.focus();
        }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" /><path d="M6 3v10M10 3v10" stroke="currentColor" />
        </svg>
        Columns <span className="columns-count">{visible.length}</span>
      </button>
      <div id={id} ref={panel} popover="auto" role="dialog" aria-labelledby={`${id}-title`} className="columns-popover"
        onToggle={() => setOpen(panel.current?.matches(":popover-open") ?? false)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
        <div className="columns-heading">
          <strong id={`${id}-title`}>Display columns</strong>
          <div className="columns-description">{draft.length} of {fields.length} selected</div>
        </div>
        <div className="columns-search">
          <input ref={search} type="search" name="column-search" aria-label="Search columns" placeholder="Search columns..."
            value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="columns-options" role="group" aria-label="Visible columns">
          {matches.length ? matches.map((f) => (
            <label key={f} className="columns-option">
              <input type="checkbox" name="visible-columns" value={f} checked={draft.includes(f)} disabled={draft.length === 1 && draft.includes(f)}
                onChange={(e) => { const on = e.target.checked; setDraft((d) => (on ? [...d, f] : d.filter((c) => c !== f))); }} />
              <span>{f.replaceAll("_", " ")}</span>
            </label>
          )) : <p className="columns-empty">No matching columns.</p>}
        </div>
        <div className="columns-footer">
          <button type="button" className="columns-reset" onClick={() => { onChange(undefined); close(); }}>Reset</button>
          <button type="button" className="primary" disabled={!draft.length}
            onClick={() => { onChange(fields.filter((f) => draft.includes(f))); close(); }}>Apply</button>
        </div>
      </div>
    </>
  );
}
