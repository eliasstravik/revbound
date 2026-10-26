/**
 * "Open database". Hosted it links to Neon's console (or Vercel's Storage tab). Locally it starts Drizzle Studio on the
 * database the app uses, with the project's own drizzle-kit and drizzle.config.ts, once per dev server, on 127.0.0.1.
 * Pressed over this machine's Tailscale name, Studio is also shared with that same Tailscale login only: Serve on a free
 * HTTPS port (never Funnel) in front of a loopback gate. Studio and the share stop with the dev server.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest, type Server } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { assertNotProduction, HttpError, isHosted, json, loopback, requestHost, tailnetLogin, value } from "revbound/kit";

const STUDIO_PORT = 4983, SERVE_PORT = 8443, READY = /https:\/\/local\.drizzle\.studio/;
// Studio has an IPC channel to this server; when the server goes, however it goes, the channel closes and Studio exits.
const ORPHAN_GUARD = `data:text/javascript,process.once("disconnect",()=>process.exit())`;

type State = { url?: string; port?: Promise<number>; current?: number; child?: ChildProcess; owner?: string; share?: Promise<string>; hooked?: boolean };
// On globalThis, so a module reload in next dev still finds the one Studio.
const state: State = ((globalThis as { __gtmStudio?: State }).__gtmStudio ??= {});

/** GET /database (session) → what the button does here: `{ mode: "local" }` on this computer or to a Tailscale login on
 * its name (none for other allowed hosts), or a link to the database's console. */
export async function destination(req: Request): Promise<Response> {
  if (!isHosted()) return json({ mode: loopback(req) || tailnetLogin(req) ? "local" : "none" });
  const neon = value("NEON_PROJECT_ID");
  if (neon) return json({ mode: "link", url: `https://console.neon.tech/app/projects/${encodeURIComponent(neon)}`, label: "Open in Neon", title: "This project's database in the Neon console" });
  // Neon accounts Vercel installed open Neon's console from the Storage tab.
  const to = encodeURIComponent("/[team]/[project]/stores");
  return json({ mode: "link", url: `https://vercel.com/d?to=${to}&title=Storage`, label: "Open in Vercel", title: "Storage → Open in Neon" });
}

/** POST /database/open (tailnet) → { url }: Drizzle Studio's address, on this computer or shared with the caller's login. */
export async function open(req: Request): Promise<Response> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, "Send JSON.");
  const login = loopback(req) ? undefined : tailnetLogin(req), host = requestHost(req).replace(/:\d+$/, "");
  if (login && host !== (await tailnetName())) throw new HttpError(409, "Open database works over this computer's own Tailscale name only.");
  const url = value("DATABASE_URL");
  if (!url) throw new HttpError(503, "DATABASE_URL is not set; start the app with npm run dev (revbound dev).");
  await refuseProduction(url);
  const port = await studio(url);
  if (!login) return json({ url: `https://local.drizzle.studio/?port=${port}` });
  if (state.owner && state.owner !== login) throw new HttpError(409, "Studio is shared with another Tailscale login; restart revbound dev to share it with yours.");
  state.owner = login;
  state.share ??= share(login, host, Number(requestHost(req).split(":")[1] ?? 443)).catch((error) => {
    state.share = state.owner = undefined;
    throw error;
  });
  return json({ url: await state.share });
}

async function refuseProduction(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await assertNotProduction(async (sql) => (await client.query(sql)).rows, url);
  } catch (error) {
    throw new HttpError(409, (error as Error).message);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Studio's port: the running one, or a new Studio on the first free port from 4983 (restarted when DATABASE_URL moved). */
function studio(url: string): Promise<number> {
  if (state.url !== url) { state.child?.kill(); state.child = state.port = state.current = undefined; }
  state.url = url;
  state.port ??= start(url).then((port) => (state.current = port), (error) => {
    state.port = undefined;
    throw error;
  });
  return state.port;
}

async function start(url: string): Promise<number> {
  const dir = process.cwd(), kit = join(/*turbopackIgnore: true*/ dir, "node_modules", "drizzle-kit");
  let bin: string | Record<string, string>;
  try { ({ bin } = JSON.parse(readFileSync(join(kit, "package.json"), "utf8"))); } catch {
    throw new HttpError(503, "drizzle-kit is not installed in this project: run `npm install`.");
  }
  const port = await freePort(STUDIO_PORT);
  const child = spawn(process.execPath, ["--import", ORPHAN_GUARD, join(kit, typeof bin === "string" ? bin : bin["drizzle-kit"]),
    "studio", "--host", "127.0.0.1", "--port", String(port)], { cwd: dir, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  state.child = child;
  if (!state.hooked) {
    state.hooked = true;
    process.once("exit", () => { state.child?.kill(); removeStudioShare(dir); });
  }
  return new Promise<number>((done, fail) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); fail(new HttpError(503, "Drizzle Studio did not start within 30 s.")); }, 30_000);
    const read = (chunk: Buffer) => {
      output = (output + chunk).replace(/\x1b\[[0-9;]*m/g, "").slice(-4000); // colour codes off before matching
      if (READY.test(output)) { clearTimeout(timer); done(port); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", () => {
      clearTimeout(timer);
      if (state.child === child) state.child = state.port = state.current = undefined;
      const reason = output.trim().split("\n").at(-1);
      fail(new HttpError(503, `Drizzle Studio stopped${reason ? `: ${reason}` : "."}`));
    });
  });
}

/** The first port from `from` that 127.0.0.1 can listen on. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 20; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createServer().once("error", () => done(false)).listen(port, "127.0.0.1", () => probe.close(() => done(true)));
    });
    if (free) return port;
  }
  throw new HttpError(503, `No free port for Drizzle Studio (tried ${from}–${from + 19}).`);
}

const tailscale = (args: string[]) => new Promise<string>((done, fail) => execFile("tailscale", args, { timeout: 15_000 },
  (error, stdout, stderr) => (error ? fail(new Error(`tailscale ${args.join(" ")}: ${(stderr || error.message).trim()}`)) : done(stdout))));

/** This machine's tailnet name (`tailscale status` Self.DNSName without the dot), or undefined. */
const tailnetName = () => tailscale(["status", "--json"])
  .then((out) => String(JSON.parse(out).Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase() || undefined, () => undefined);

type ServeStatus = { TCP?: Record<string, unknown>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
const shareFile = (dir: string) => join(/*turbopackIgnore: true*/ dir, ".gtm", "studio-share.json");

/**
 * Shares Studio on `host` with `owner` alone: a loopback gate, then Serve on the first HTTPS port no share uses (so
 * nothing already shared is replaced), checked to point there with Funnel off. Recorded in .gtm/ so revbound dev removes it.
 */
async function share(owner: string, host: string, consolePort: number): Promise<string> {
  const dir = process.cwd();
  removeStudioShare(dir); // one a crash left behind
  const gate = await studioGate(owner);
  try {
    const status = async () => JSON.parse((await tailscale(["serve", "status", "--json"])) || "{}") as ServeStatus;
    const used = new Set(Object.keys((await status()).TCP ?? {}).map(Number)).add(consolePort);
    let https = SERVE_PORT;
    while (used.has(https)) https++;
    const target = `http://127.0.0.1:${(gate.address() as AddressInfo).port}`, key = `${host}:${https}`;
    await tailscale(["serve", "--bg", `--https=${https}`, target]);
    mkdirSync(join(/*turbopackIgnore: true*/ dir, ".gtm"), { recursive: true });
    writeFileSync(shareFile(dir), JSON.stringify({ host, https, target }));
    const after = await status();
    if (after.Web?.[key]?.Handlers?.["/"]?.Proxy !== target || after.AllowFunnel?.[key]) {
      removeStudioShare(dir);
      throw new Error("Tailscale Serve did not take the share as a tailnet-only proxy to Studio.");
    }
    return `https://local.drizzle.studio/?host=${host}&port=${https}`;
  } catch (error) {
    gate.close();
    throw new HttpError(502, `Could not share Drizzle Studio on the tailnet. ${(error as Error).message}`);
  }
}

/** A loopback relay to Studio that lets through only requests Serve marks with `owner`'s login, never Funnel ones. */
async function studioGate(owner: string): Promise<Server> {
  const server = httpServer((req, res) => {
    const login = String(req.headers["tailscale-user-login"] ?? "").trim().toLowerCase();
    if (req.headers["tailscale-funnel-request"] || login !== owner || !state.current) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Only the Tailscale login that pressed Open database gets in.");
      return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: state.current, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.once("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end("Drizzle Studio is not running.")));
    req.pipe(upstream);
  });
  await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
  server.unref();
  return server;
}

/** Removes the recorded Studio share while Serve still points it at the recorded gate. Sync, never throws (revbound dev runs it on exit). */
export function removeStudioShare(dir: string): void {
  let s: { host: string; https: number; target: string };
  try { s = JSON.parse(readFileSync(shareFile(dir), "utf8")); } catch { return; }
  try {
    const run = (args: string[]) => spawnSync("tailscale", args, { encoding: "utf8", timeout: 15_000 });
    const status = JSON.parse(run(["serve", "status", "--json"]).stdout || "{}") as ServeStatus;
    const ours = status.Web?.[`${s.host}:${s.https}`]?.Handlers?.["/"]?.Proxy === s.target;
    if (!ours || run(["serve", `--https=${s.https}`, "off"]).status === 0) rmSync(shareFile(dir), { force: true });
  } catch {}
}
