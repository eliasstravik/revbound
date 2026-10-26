"use client";
import type { CSSProperties, MouseEvent } from "react";
import { Link, Markdown, Status, useApi, useQuery } from "revbound/ui";
import "./context.css";

type File = { path: string; title: string; description?: string };
type Group = { name: string; files: File[] };
type Item = { key: string; label: string; depth: number; file?: File };

/** What an empty group says: what goes in it and how to add some. */
const EMPTY: Record<string, [string, string]> = {
  Context: ["No context yet.", "Who you sell to and how you sound. Ask your agent to write it."],
  Skills: ["No skills yet.", "Skills teach your agent tasks it repeats. Ask your agent to add one."],
};

/** Tree rows: each folder once, files indented under it (paths arrive sorted), named without `.md`. Skills are labelled by their name. */
function tree(group: Group): Item[] {
  const out: Item[] = [];
  let prev: string[] = [];
  for (const file of group.files) {
    const parts = file.path.split("/");
    if (group.name === "Skills") { out.push({ key: file.path, label: file.title, depth: 0, file }); continue; }
    const dirs = parts.slice(1, -1); // under context/
    let i = 0;
    while (i < dirs.length && dirs[i] === prev[i]) i += 1;
    for (; i < dirs.length; i += 1) out.push({ key: `${dirs.slice(0, i + 1).join("/")}/`, label: dirs[i], depth: i });
    out.push({ key: file.path, label: parts.at(-1)!.replace(/\.md$/, ""), depth: dirs.length, file });
    prev = dirs;
  }
  return out;
}

/**
 * Context: the company's context files and skills as a tree (a picker on phones); the selected one (`?file=`) rendered
 * read-only, a skill with its description as the lead instead of its front matter.
 */
export default function ContextView() {
  const { params, href, go } = useQuery();
  const list = useApi<{ groups: Group[] }>("context");
  const groups = list.data?.groups ?? [];
  const path = params.get("file") ?? groups.find((g) => g.files.length)?.files[0].path ?? null;
  const skill = groups.find((g) => g.name === "Skills")?.files.find((f) => f.path === path);
  const doc = useApi<{ path: string; markdown: string; githubUrl: string | null }>(path && `context/file?path=${encodeURIComponent(path)}`);
  // A relative link to another listed file (e.g. `icps/enterprise.md`) opens it here instead of leaving the Console.
  const follow = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a")?.getAttribute("href");
    if (!link || !path || e.metaKey || e.ctrlKey || e.shiftKey || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(link)) return;
    const target = decodeURIComponent(new URL(link, `http://x/${path}`).pathname.slice(1));
    if (!groups.some((g) => g.files.some((f) => f.path === target))) return;
    e.preventDefault();
    go({ file: target });
    scrollTo({ top: 0 });
  };
  const trees = groups.map((g) => ({ ...g, items: tree(g) }));
  return (
    <>
      <div className="title-row"><h1>Context</h1></div>
      {!list.data ? <Status state={list} /> : (
        <div className="context">
          <nav className="file-tree" aria-label="Context files">
            {trees.map((g) => (
              <section key={g.name}>
                <h2>{g.name}</h2>
                {!g.files.length && <div className="tree-empty">{(EMPTY[g.name] ?? ["None yet."]).map((t) => <p key={t}>{t}</p>)}</div>}
                <ul>
                  {g.items.map((it) => (
                    <li key={it.key} style={{ "--depth": it.depth } as CSSProperties}>
                      {it.file ? (
                        <Link href={href({ file: it.file.path })} title={it.file.description ?? it.file.title} aria-current={it.file.path === path ? "page" : undefined}>
                          {it.label}{it.file.description && <small>{it.file.description}</small>}
                        </Link>
                      ) : <span className="dir">{it.label}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </nav>
          <article className="doc" onClick={follow}>
            {path && (
              <select className="file-pick" name="file" aria-label="File" value={path} onChange={(e) => go({ file: e.target.value })}>
                {trees.map((g) => g.files.length > 0 && (
                  <optgroup key={g.name} label={g.name}>
                    {g.items.flatMap((it) => it.file ? [<option key={it.key} value={it.file.path}>{g.name === "Skills" ? it.label : it.file.path.slice(8, -3)}</option>] : [])}
                  </optgroup>
                ))}
              </select>
            )}
            {/* Phones only: there the tree, which says what each empty group is for, is hidden. */}
            {!path ? <p className="notice none">No context yet. Ask your agent to write it.</p> : !doc.data ? <Status state={doc} /> : <>
              {doc.data.githubUrl && <div className="doc-head"><a href={doc.data.githubUrl} target="_blank" rel="noreferrer">Open on GitHub ↗</a></div>}
              <Markdown source={doc.data.markdown} lead={skill && (skill.description ?? null)} />
            </>}
          </article>
        </div>
      )}
    </>
  );
}
