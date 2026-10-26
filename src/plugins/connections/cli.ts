/**
 * `revbound connections list | set <NAME> | delete <NAME>`: local keys in .env.local (mode 0600). A value is read from a
 * no-echo prompt or stdin, never argv, and never printed.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliCtx, loadEnv } from "revbound/cli";
import { value } from "revbound/kit";
import { ENTRY, envLocalNames, exampleConnections } from "revbound/kit/dotenv";

const USAGE = "Usage: revbound connections list | set <NAME> | delete <NAME> (set reads the value from a hidden prompt or stdin)";

/** Names Revbound, Vercel or an integration set; `set` refuses them. */
export function refusedName(name: string): boolean {
  return /^(DATABASE_URL|POSTGRES_|PG|REVBOUND_|VERCEL_|NEON_)|^CRON_SECRET$/.test(name.toUpperCase());
}

/** The value rules: one line, at most 32 KB, not both ' and `, no trailing backslash (so @next/env reads it back as is). */
export function checkValue(v: string): string | undefined {
  if (!v.length || v.length > 32_768) return "The value is empty or too long.";
  if (/[\r\n\0]/.test(v)) return "The value must be one line.";
  if (v.includes("'") && v.includes("`")) return "The value cannot contain both ' and `.";
  if (v.endsWith("\\")) return "The value cannot end in \\.";
  return undefined;
}

/** Written beside the file and renamed over it (a crash never leaves half a file); the temp name is gitignored (.env*.local). */
function writeAtomic(dir: string, text: string): void {
  const temp = join(dir, `.env.revbound-${randomUUID()}.local`), file = join(dir, ".env.local");
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  try { renameSync(temp, file); chmodSync(file, 0o600); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

/**
 * NAME='value' (backticks when it contains ') in .env.local, `$` escaped so @next/env reads it back as is; null removes
 * it. Every NAME entry goes whole, from its key to the end of its value as @next/env reads it, so no part of an old value
 * stays and no other entry is touched; the new one takes the first one's place.
 */
export function writeEnvLocal(dir: string, name: string, v: string | null): void {
  const path = join(dir, ".env.local");
  const text = (existsSync(path) ? readFileSync(path, "utf8") : "").replace(/\r\n?/g, "\n"), lines = text.split("\n");
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const spans = [...text.matchAll(ENTRY)].filter((m) => m[1] === name).map((m) => [lineOf(m.indices![1][0]), lineOf((m.indices![2] ?? m.indices![1])[1])]);
  if (v === null && !spans.length) return;
  const q = v?.includes("'") ? "`" : "'", entry = v === null ? [] : [`${name}=${q}${v.replaceAll("$", "\\$")}${q}`];
  const next = !spans.length ? [...lines.slice(0, lines.at(-1) === "" ? -1 : undefined), ...entry, ""]
    : lines.flatMap((l, i) => (!spans.some(([from, to]) => i >= from && i <= to) ? [l] : i === spans[0][0] ? entry : []));
  writeAtomic(dir, next.join("\n"));
}

/** The value from a hidden prompt on a terminal, else all of stdin (one trailing newline dropped). */
async function readSecret(name: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stdout.write(`Value for ${name} (hidden): `);
  return new Promise((done, fail) => {
    const input = process.stdin;
    let text = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const on = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") { finish(); done(text); return; }
        if (c === "\u0003") { finish(); fail(new Error("Cancelled.")); return; }
        if (c === "\u007f" || c === "\b") text = text.slice(0, -1);
        else text += c;
      }
    };
    const finish = () => { input.off("data", on); input.setRawMode(false); input.pause(); process.stdout.write("\n"); };
    input.on("data", on);
  });
}

export default async function connections(args: string[], ctx: CliCtx): Promise<void> {
  const [action, name, ...rest] = args;
  if (rest.length || !action || (action !== "list" && !name) || (action === "list" && name)) throw new Error(USAGE);
  loadEnv(ctx.dir, true);
  if (action === "list") {
    const local = envLocalNames(ctx.dir), names = new Map(exampleConnections(ctx.dir).map((c) => [c.name, c.description]));
    for (const p of ctx.config.plugins) for (const c of p.connections ?? []) if (!names.has(c.name)) names.set(c.name, c.label);
    if (!names.size) return console.log("No connections listed in .env.example or declared by plugins.");
    for (const [n, label] of names) console.log(`${(value(n) !== undefined || local.includes(n) ? "set    " : "missing")}  ${n}${label ? `  (${label})` : ""}`);
    return;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)) throw new Error("A key takes letters, digits and _ and cannot start with a digit.");
  if (refusedName(name)) throw new Error(`${name} is set by Revbound, Vercel or an integration, not here.`);
  if (action === "delete") {
    if (!envLocalNames(ctx.dir).includes(name)) throw new Error(`${name} is not in .env.local.`);
    writeEnvLocal(ctx.dir, name, null);
    return console.log(`Deleted ${name} from .env.local.`);
  }
  if (action !== "set") throw new Error(USAGE);
  const v = await readSecret(name), bad = checkValue(v);
  if (bad) throw new Error(bad);
  writeEnvLocal(ctx.dir, name, v);
  const shell = process.env[name] !== undefined && !envLocalNames(ctx.dir).includes(name);
  console.log(`Saved ${name} to .env.local.${shell ? ` Your shell sets ${name} too, and that value wins while revbound dev runs.` : ""}`);
  if (!exampleConnections(ctx.dir).some((c) => c.name === name) && !ctx.config.plugins.some((p) => p.connections?.some((c) => c.name === name)))
    console.log(`List it in .env.example (a "# label" line, then ${name}=) so teammates and the console know it.`);
}
