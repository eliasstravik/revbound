/** `.env.example` and `.env.local` as Revbound reads them. Node only (the CLI and local route handlers). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PULL_PLACEHOLDER } from "./env.js";

/**
 * Connections from `.env.example`: every `NAME=` line (optionally `export NAME=`) is one; the `#` comment on the line
 * directly above it is its description (no comment, or a blank line between, means none). First occurrence wins.
 */
export function exampleConnections(dir = process.cwd()): { name: string; description: string }[] {
  const path = join(/*turbopackIgnore: true*/ dir, ".env.example"), found = new Map<string, string>();
  let comment = "";
  for (const line of existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : []) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !found.has(m[1])) found.set(m[1], comment);
    comment = /^\s*#/.test(line) ? line.replace(/^\s*#+/, "").trim() : "";
  }
  return [...found].map(([name, description]) => ({ name, description }));
}

/**
 * dotenv 16.3's entry rule, which @next/env reads .env.local with (copied from it, so both always agree): one match
 * per entry, a quoted value over several lines included, `\'` inside quotes as dotenv takes it.
 */
export const ENTRY = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/dgm;

/** Names with a value in `.env.local` as @next/env reads it (the last entry wins; Vercel's pull placeholder counts as none). */
export function envLocalNames(dir = process.cwd()): string[] {
  const path = join(/*turbopackIgnore: true*/ dir, ".env.local");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const values = new Map([...text.replace(/\r\n?/g, "\n").matchAll(ENTRY)]
    .map((m) => [m[1], (m[2] ?? "").trim().replace(/^(['"`])([\s\S]*)\1$/, "$2")] as const));
  return [...values].filter(([, v]) => v && v !== PULL_PLACEHOLDER).map(([k]) => k);
}
