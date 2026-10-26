/**
 * Harness for the acceptance checks: pack the package, create a project from the tarball, run commands with an
 * empty environment, start and stop long-running servers, send raw HTTP (custom Host), list listening sockets.
 * Linux only (`ss`, /proc). Nothing here talks to anything but the npm registry and 127.0.0.1.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("..", import.meta.url));
export const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The only environment commands get: PATH and HOME (needed to run anything), the harness's telemetry opt-outs, extras. */
export function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: "1", EVE_TELEMETRY_DISABLED: "1", ...extra };
}

/** A fresh work folder under REVBOUND_TEST_DIR (default: the OS temp dir). */
export function makeWorkDir() {
  const base = process.env.REVBOUND_TEST_DIR ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, "revbound-acceptance-"));
}

let logs = null;
let seq = 0;
/** Where every command's output is written (REVBOUND_TEST_LOGS, else <work>/logs). */
export function setLogDir(dir) {
  logs = dir;
  fs.mkdirSync(dir, { recursive: true });
}
function openLog(name) {
  const file = path.join(logs ?? os.tmpdir(), `${String(++seq).padStart(3, "0")}-${name.replace(/[^\w.-]+/g, "_")}.log`);
  return { file, fd: fs.openSync(file, "w") };
}

function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch {}
}

/**
 * Runs a command to completion. Resolves (never rejects on a non-zero exit) with code, stdout, stderr, output.
 * Leftover processes in its group are killed and reported, so a command cannot leave a server behind unnoticed.
 */
export function run(cmd, args, { cwd = REPO, env = cleanEnv(), timeout = 10 * MIN, name, input } = {}) {
  return new Promise((resolve, reject) => {
    const log = openLog(name ?? `${path.basename(cmd)}-${args.filter((a) => !a.startsWith("-"))[0] ?? ""}`);
    fs.writeSync(log.fd, `$ ${[cmd, ...args].join(" ")}\n# cwd ${cwd}\n# env ${Object.keys(env).join(" ")}\n`);
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    let stdout = "", stderr = "", output = "", timedOut = false, done = false;
    const add = (which) => (d) => {
      const s = d.toString();
      if (which === "out") stdout += s; else stderr += s;
      output += s;
      try { fs.writeSync(log.fd, s); } catch {}
    };
    child.stdout.on("data", add("out"));
    child.stderr.on("data", add("err"));
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, "SIGKILL"); }, timeout);
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const leftovers = [...processTree(child.pid)].filter((p) => p !== child.pid && alive(p));
      if (leftovers.length) {
        fs.writeSync(log.fd, `\n# leftover processes killed: ${leftovers.join(" ")}\n`);
        killGroup(child.pid, "SIGKILL");
      }
      fs.writeSync(log.fd, `\n# exit ${code ?? signal}${timedOut ? " (timed out)" : ""}\n`);
      fs.closeSync(log.fd);
      resolve({ cmd: [cmd, ...args].join(" "), code: code ?? 128, signal, stdout, stderr, output, timedOut, leftovers, log: log.file });
    };
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 2000)); // a leftover may hold the pipes
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** Throws with the command's output tail unless it exited 0. */
export function assertOk(result, what = result.cmd) {
  if (result.code === 0 && !result.timedOut) return result;
  throw new Error(`${what} exited ${result.timedOut ? "by timeout" : result.code} (log ${result.log}):\n${tail(result.output)}`);
}

export function tail(text, n = 6000) {
  return text.length > n ? `…${text.slice(-n)}` : text;
}

const running = new Set();

/** Starts a long-running process in its own group; output goes to a log and a capped in-memory buffer. */
export function startProcess(cmd, args, { cwd, env = cleanEnv(), name }) {
  const log = openLog(name ?? path.basename(cmd));
  fs.writeSync(log.fd, `$ ${[cmd, ...args].join(" ")}\n# cwd ${cwd}\n# env ${Object.keys(env).join(" ")}\n`);
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const proc = { child, pid: child.pid, cwd, output: "", exitCode: undefined, log: log.file };
  const add = (d) => {
    proc.output = (proc.output + d.toString()).slice(-1_000_000);
    try { fs.writeSync(log.fd, d); } catch {}
  };
  child.stdout.on("data", add);
  child.stderr.on("data", add);
  proc.exited = new Promise((resolve) => child.on("exit", (code, signal) => {
    proc.exitCode = code ?? 128;
    try { fs.writeSync(log.fd, `\n# exit ${code ?? signal}\n`); fs.closeSync(log.fd); } catch {}
    resolve(proc.exitCode);
  }));
  proc.stop = () => stopProcess(proc);
  running.add(proc);
  return proc;
}

/** Stops a process like Ctrl-C does (SIGINT to its group), escalating; kills anything left in its tree. */
export async function stopProcess(proc) {
  running.delete(proc);
  const tree = [...processTree(proc.pid)];
  if (proc.exitCode === undefined) {
    killGroup(proc.pid, "SIGINT");
    if (!(await within(proc.exited, 20_000))) {
      killGroup(proc.pid, "SIGTERM");
      if (!(await within(proc.exited, 5_000))) killGroup(proc.pid, "SIGKILL");
    }
    await within(proc.exited, 5_000);
  }
  killGroup(proc.pid, "SIGKILL");
  for (const pid of tree) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
}

/** Stops everything this harness started (used in after() and on exit). */
export async function stopAll() {
  await Promise.all([...running].map((p) => stopProcess(p)));
}
process.on("exit", () => { for (const p of running) killGroup(p.pid, "SIGKILL"); });

/** Resolves true if `promise` settles within `ms`, else false. */
export async function within(promise, ms) {
  return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Raw HTTP to 127.0.0.1:<port> through node:http (fetch cannot set Host). `body` objects are sent as JSON, strings
 * and Buffers as they are (JSON unless `headers` name another content-type).
 * Never follows redirects. Resolves with { status, headers, text, json() }.
 */
export function request(port, pathname, { method = "GET", host = `127.0.0.1:${port}`, headers = {}, body, timeout = 2 * MIN } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { host, ...headers };
    if (data !== undefined) Object.assign(h, { "content-type": h["content-type"] ?? "application/json", "content-length": Buffer.byteLength(data) });
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: h, timeout }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode, headers: res.headers, text,
          json() {
            try { return JSON.parse(text); } catch { throw new Error(`${method} ${pathname}: not JSON (${res.statusCode}): ${text.slice(0, 300)}`); }
          },
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout: ${method} ${pathname}`)));
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/** Waits until 127.0.0.1:<port> answers HTTP on `pathname` (any status), failing early if `proc` exits. */
export async function waitForHttp(port, pathname, proc, timeout = 6 * MIN) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (proc?.exitCode !== undefined) throw new Error(`${proc.log}: exited ${proc.exitCode} before answering:\n${tail(proc.output)}`);
    try {
      return await request(port, pathname, { timeout: 3 * MIN });
    } catch {
      if (Date.now() > deadline) throw new Error(`127.0.0.1:${port}${pathname} did not answer in ${timeout / 1000}s:\n${tail(proc?.output ?? "")}`);
      await sleep(1000);
    }
  }
}

/** True when something accepts TCP connections on 127.0.0.1:<port>. */
export function portOpen(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(true); });
    req.end();
  });
}

/** Polls `fn` until it returns a truthy value (returned) or the time runs out (returns the last value). */
export async function poll(fn, { timeout = 30_000, every = 500 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = await fn(); } catch (e) { value = undefined; if (Date.now() > deadline) throw e; }
    if (value || Date.now() > deadline) return value;
    await sleep(every);
  }
}

/**
 * The pids of a process tree: descendants of `root`, members of its process group, and (when `cwd` is given) any
 * process whose working directory is inside `cwd`, so a server that daemonized itself is still counted.
 */
export function processTree(root, cwd) {
  const procs = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      procs.set(Number(name), { ppid: Number(f[1]), pgid: Number(f[2]) });
    } catch {}
  }
  const tree = new Set(procs.has(root) ? [root] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, p] of procs) if (!tree.has(pid) && (tree.has(p.ppid) || p.pgid === root)) { tree.add(pid); grew = true; }
  }
  if (cwd) {
    for (const pid of procs.keys()) {
      try {
        const where = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (pid !== process.pid && (where === cwd || where.startsWith(cwd + path.sep))) tree.add(pid);
      } catch {}
    }
  }
  return tree;
}

/**
 * Kills every process still running inside `dir` (detached ones escape their group, e.g. Next's telemetry flush,
 * which loads next.config and so starts the workflow builder). Returns their command lines.
 */
export function killInside(dir) {
  const strays = [...processTree(-1, dir)].map((pid) => {
    let cmd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim(); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
    return `${pid} ${cmd}`;
  });
  return strays;
}

/** Every listening TCP socket (IPv4 and IPv6) owned by one of `pids`, from `ss -ltnp`. */
export function listeningSockets(pids) {
  const out = execFileSync("ss", ["-H", "-l", "-t", "-n", "-p"], { encoding: "utf8" });
  const sockets = [];
  for (const line of out.split("\n")) {
    const owners = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    if (!owners.some((p) => pids.has(p))) continue;
    const local = line.trim().split(/\s+/)[3];
    const i = local.lastIndexOf(":");
    const address = local.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    sockets.push({ local, address, port: Number(local.slice(i + 1)), pids: owners });
  }
  return sockets;
}

/** Packs the package: REVBOUND_TEST_TARBALL if set, else a copy of this repo (its node_modules linked) built and packed. */
export async function packPackage(work) {
  if (process.env.REVBOUND_TEST_TARBALL) return path.resolve(process.env.REVBOUND_TEST_TARBALL);
  const copy = path.join(work, "pkg-src");
  const skip = new Set(["node_modules", "dist", ".git", ".revbound"]);
  fs.cpSync(REPO, copy, {
    recursive: true, verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(REPO, src);
      return !skip.has(rel.split(path.sep)[0]) && !rel.endsWith(".tgz");
    },
  });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(copy, "node_modules"));
  assertOk(await run("npm", ["run", "build"], { cwd: copy, name: "pack-build" }));
  const packed = assertOk(await run("npm", ["pack", "--json", "--pack-destination", work], { cwd: copy, name: "pack" }));
  return path.join(work, JSON.parse(packed.stdout)[0].filename);
}

/**
 * Extracts the tarball and returns its dist/cli.js, as `npx <tarball>` would run it. Its dependencies come from this
 * repo's node_modules when present (same lockfile), else from `npm install` (which also installs the peers, like npx).
 */
export async function extractCli(tarball, work) {
  const dir = path.join(work, "cli");
  fs.mkdirSync(dir, { recursive: true });
  assertOk(await run("tar", ["-xzf", tarball, "-C", dir], { name: "extract" }));
  const pkg = path.join(dir, "package");
  const modules = path.join(REPO, "node_modules");
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(pkg, "node_modules"));
  else assertOk(await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: pkg, name: "cli-install" }));
  return path.join(pkg, "dist", "core", "cli.js");
}

/** Snapshot of a project tree: relative path → content hash, "dir", or "-> <link target>". */
export function snapshot(dir, skip = ["node_modules", ".next", ".revbound", ".workflow-data", ".eve", ".vercel", ".turbo", ".swc"]) {
  const out = new Map();
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skip.includes(e.name)) continue;
      const abs = path.join(dir, r);
      if (e.isSymbolicLink()) out.set(r, `-> ${fs.readlinkSync(abs)}`);
      else if (e.isDirectory()) { out.set(r, "dir"); walk(r); }
      else out.set(r, createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    }
  };
  walk("");
  return out;
}

/** What changed between two snapshots. */
export function diffSnapshots(before, after) {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  return { added, removed, changed };
}

/** Runs one SQL statement through the project's own `pg` (a dependency of the package). */
export async function sql(projectDir, url, text, params = []) {
  const pg = createRequire(path.join(projectDir, "package.json"))("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** A throwaway HTTPS server on 127.0.0.1 with a self-signed certificate (trusted by passing `caFile` as NODE_EXTRA_CA_CERTS). */
export async function httpsStub(work, port, handler) {
  const dir = fs.mkdtempSync(path.join(work, "tls-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return { caFile: cert, close: () => new Promise((r) => server.close(r)) };
}
