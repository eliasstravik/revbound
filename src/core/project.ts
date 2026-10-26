import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import type { Env } from "../kit/env.js";

/** The installed package's root (holds starter/, docs/, src/plugins/). */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Parsed JSON file, or undefined when it is missing or unreadable. */
export function readJson<T = any>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

/** True when `dir` holds a Revbound project: a package.json that depends on revbound. */
export function isRevboundProject(dir: string): boolean {
  const pkg = readJson(join(dir, "package.json"));
  return Boolean(pkg?.dependencies?.["revbound"] ?? pkg?.devDependencies?.["revbound"]);
}

/** The nearest folder at or above `from` that holds a Revbound project (package.json depending on revbound). */
export function findProject(from = process.cwd()): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (isRevboundProject(dir)) return dir;
    if (dirname(dir) === dir) throw new Error("No Revbound project here. Create one with `npx revbound init --company <name>` (makes ./revbound-<company>).");
  }
}

/** Loads .env files exactly as Next does (shell wins) into process.env and returns it. */
export function loadEnv(dir: string, dev: boolean): Env {
  nextEnv.loadEnvConfig(dir, dev, { info: () => {}, error: console.error }, true);
  return process.env;
}

const BEGIN = "<!-- BEGIN:revbound -->";
const END = "<!-- END:revbound -->";

/** The managed AGENTS.md block, markers included, or undefined when `text` has none. */
export function extractBlock(text: string): string | undefined {
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  return end < 0 ? undefined : text.slice(start, end + END.length).replace(/\r\n/g, "\n");
}

/** `text` with its managed block replaced by `block`, or with `block` appended when it has none. */
export function withBlock(text: string, block: string): string {
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  if (end >= 0) return text.slice(0, start) + block + text.slice(end + END.length);
  return (text.trim() ? `${text.trimEnd()}\n\n` : "") + `${block}\n`;
}
