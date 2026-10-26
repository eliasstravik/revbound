/**
 * `revbound connections list | set <NAME> | delete <NAME>`: local keys in .env.local (mode 0600). A value is read from a
 * no-echo prompt or stdin, never argv, and never printed.
 */
import { type CliCtx, loadEnv } from "revbound/cli";
import { value } from "revbound/kit";
import { envLocalNames, exampleConnections } from "revbound/kit/dotenv";
import { checkValue, KEY, refusedName, writeEnvLocal } from "./files.js";

const USAGE = "Usage: revbound connections list | set <NAME> | delete <NAME> (set reads the value from a hidden prompt or stdin)";

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
  if (!KEY.test(name)) throw new Error("A key takes letters, digits and _ and cannot start with a digit.");
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
