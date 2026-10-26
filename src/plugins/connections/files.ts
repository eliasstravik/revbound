/**
 * Local keys: values in .env.local (mode 0600), names and labels in .env.example. Node only: the CLI and the local
 * Connections routes. Values are never logged or returned.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY } from "revbound/kit/dotenv";

/** Names Revbound, Vercel or an integration set; nothing here writes them. Hosted also AI Gateway's, which OIDC stands in for. */
export function refusedName(name: string, hosted = false): boolean {
  const n = name.toUpperCase();
  return /^(DATABASE_URL|POSTGRES_|PG|REVBOUND_|VERCEL_|NEON_|SLACK_|GITHUB_|EVE_)|^CRON_SECRET$/.test(n) || (hosted && n.startsWith("AI_GATEWAY_"));
}

/** A key: letters, digits and _, not starting with a digit. */
export const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

/** The value rules: one line, at most 32 KB, not both ' and `, no trailing backslash (so @next/env reads it back as is). */
export function checkValue(v: string): string | undefined {
  if (!v.length || v.length > 32_768) return "The value is empty or too long.";
  if (/[\r\n\0]/.test(v)) return "The value must be one line.";
  if (v.includes("'") && v.includes("`")) return "The value cannot contain both ' and `.";
  if (v.endsWith("\\")) return "The value cannot end in \\.";
  return undefined;
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** Written beside the file and renamed over it (a crash never leaves half a file); the temp name is gitignored (.env*.local). */
function writeAtomic(dir: string, name: string, text: string, mode: number): void {
  const temp = join(/*turbopackIgnore: true*/ dir, `.env.revbound-${randomUUID()}.local`), file = join(/*turbopackIgnore: true*/ dir, name);
  writeFileSync(temp, text, { mode, flag: "wx" });
  try { renameSync(temp, file); chmodSync(file, mode); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/**
 * NAME='value' (backticks when it contains ') in .env.local, `$` escaped so @next/env reads it back as is; null removes
 * it. Every NAME entry goes whole, from its key to the end of its value as @next/env reads it, so no part of an old value
 * stays and no other entry is touched; the new one takes the first one's place.
 */
export function writeEnvLocal(dir: string, name: string, v: string | null): void {
  const text = read(join(/*turbopackIgnore: true*/ dir, ".env.local")).replace(/\r\n?/g, "\n"), lines = text.split("\n");
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const spans = [...text.matchAll(ENTRY)].filter((m) => m[1] === name).map((m) => [lineOf(m.indices![1][0]), lineOf((m.indices![2] ?? m.indices![1])[1])]);
  if (v === null && !spans.length) return;
  const q = v?.includes("'") ? "`" : "'", entry = v === null ? [] : [`${name}=${q}${v.replaceAll("$", "\\$")}${q}`];
  const next = !spans.length ? [...lines.slice(0, lines.at(-1) === "" ? -1 : undefined), ...entry, ""]
    : lines.flatMap((l, i) => (!spans.some(([from, to]) => i >= from && i <= to) ? [l] : i === spans[0][0] ? entry : []));
  writeAtomic(dir, ".env.local", next.join("\n"), 0o600);
}

/**
 * `.env.example` keeps the list in the repo: `label` becomes the `#` comment directly above NAME (NAME= is appended when
 * missing; "" leaves the comment as it is), and null removes NAME with its comment.
 */
export function writeExample(dir: string, name: string, label: string | null): void {
  const path = join(/*turbopackIgnore: true*/ dir, ".env.example"), lines = read(path).split("\n");
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`), above = (i: number) => i > 0 && /^\s*#/.test(lines[i - 1]);
  let at = lines.findIndex((l) => re.test(l));
  if (label === null) {
    if (at < 0) return;
    for (; at >= 0; at = lines.findIndex((l) => re.test(l))) lines.splice(above(at) ? at - 1 : at, above(at) ? 2 : 1);
  } else if (at < 0) {
    if (lines.at(-1) === "") lines.pop();
    if (lines.length && /^\s*#/.test(lines.at(-1)!)) lines.push(""); // not under a heading comment
    lines.push(...(label ? [`# ${label}`] : []), `${name}=`, "");
  } else if (!label || lines[at - 1] === `# ${label}`) return;
  else if (above(at)) lines[at - 1] = `# ${label}`;
  else lines.splice(at, 0, `# ${label}`);
  writeAtomic(dir, ".env.example", lines.join("\n"), existsSync(path) ? statSync(path).mode & 0o777 : 0o644);
}
