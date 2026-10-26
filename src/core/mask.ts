/** Source scanning for `revbound check`. */

/**
 * src with comments blanked (`text`), and with the contents of strings, template literals and regex literals blanked
 * too (`code`), so a pattern matched on `code` is real code. Blanks are spaces, so offsets and lines stay put.
 */
export function mask(src: string): { text: string; code: string } {
  const n = src.length, text = src.split(""), code = src.split("");
  const blank = (to: string[][], from: number, end: number) => { for (const a of to) for (let k = from; k < end; k++) if (a[k] !== "\n") a[k] = " "; };
  const open: number[] = []; // the brace depth at each template literal's `${`, to find the `}` that resumes it
  let depth = 0, regex = true, i = 0; // regex: a `/` here starts a regex literal, not a division
  /** Skips quoted text from `from` until `stop` says it ends (or the source does), blanking it in `code`. */
  const skip = (from: number, stop: (j: number) => boolean) => {
    let j = from;
    while (j < n && !stop(j)) j += src[j] === "\\" ? 2 : 1;
    blank([code], from, Math.min(j, n));
    return j;
  };
  /** A template literal's text from `from` to its end or its next `${`. */
  const template = (from: number) => {
    const j = skip(from, (k) => src[k] === "`" || (src[k] === "$" && src[k + 1] === "{"));
    regex = src[j] === "$";
    if (regex) open.push(depth);
    return j + (regex ? 2 : 1);
  };
  const WORD = /[\w$]+/y;
  while (i < n) {
    const c = src[i];
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const line = src[i + 1] === "/", stop = line ? src.indexOf("\n", i) : src.indexOf("*/", i + 2);
      const end = stop < 0 ? n : line ? stop : stop + 2;
      blank([text, code], i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      i = skip(i + 1, (k) => src[k] === c || src[k] === "\n") + 1;
      regex = false;
    } else if (c === "`") i = template(i + 1);
    else if (c === "/" && regex) {
      let j = i + 1, cls = false; // cls: inside [...], where `/` does not end the regex
      for (; j < n && src[j] !== "\n" && (cls || src[j] !== "/"); j += 1) {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
      }
      blank([code], i + 1, Math.min(j, n));
      i = j + 1;
      regex = false;
    } else if (c === "}" && open.at(-1) === depth) {
      open.pop();
      i = template(i + 1);
    } else if (/[\w$]/.test(c)) {
      WORD.lastIndex = i;
      const word = WORD.exec(src)![0];
      regex = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(word);
      i += word.length;
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      if (!/\s/.test(c)) regex = c !== ")" && c !== "]" && c !== "}";
      i += 1;
    }
  }
  return { text: text.join(""), code: code.join("") };
}

export type Import = { spec: string; typeOnly: boolean; names: string[]; line: number };

/**
 * Every import in `src`: static imports and re-exports (type-only when `import type`, `export type` or every named
 * member is `type X`), `import()` and `require()`, with the names a static import binds.
 */
export function imports(src: string): Import[] {
  const m = mask(src), out: Import[] = [];
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  /** The line of a match's first non-blank character (the pattern may start with the previous line's newline). */
  const at = (hit: RegExpExecArray | RegExpMatchArray) => lineAt(hit.index! + Math.max(0, hit[0].search(/\S/)));
  const STATIC = /(?:^|[\s;])(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']/g;
  for (const hit of m.code.matchAll(STATIC)) {
    const start = hit.index + hit[0].length, spec = m.text.slice(start, m.text.indexOf(hit[0].at(-1)!, start));
    const clause = hit[3], braces = /\{([^}]*)\}/.exec(clause)?.[1];
    const members = braces?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    const typeOnly = Boolean(hit[2]) || (!outside && members.length > 0 && members.every((n) => /^type\s/.test(n)));
    const names = members.filter((n) => !/^type\s/.test(n)).map((n) => n.split(/\s+as\s+/)[0].trim());
    out.push({ spec, typeOnly, names, line: at(hit) });
  }
  for (const hit of m.code.matchAll(/(?:^|[\s;(=,])(?:import|require)\s*\(\s*["']/g)) {
    const start = hit.index + hit[0].length;
    out.push({ spec: m.text.slice(start, m.text.indexOf(hit[0].at(-1)!, start)), typeOnly: false, names: [], line: at(hit) });
  }
  for (const hit of m.code.matchAll(/(?:^|[\s;])import\s*["']/g)) {
    const start = hit.index + hit[0].length;
    out.push({ spec: m.text.slice(start, m.text.indexOf(hit[0].at(-1)!, start)), typeOnly: false, names: [], line: at(hit) });
  }
  return out;
}
