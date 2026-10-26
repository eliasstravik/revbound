import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { type AddressInfo, type Socket, connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { value } from "revbound/kit";

/** `.revbound/db.lock`. `dev` marks a `revbound dev` server, which other commands share; short-lived servers are waited for. */
type Lock = { pid: number; port: number; dataDir: string; dev?: boolean };
export type LocalDatabase = { url: string; stop(): Promise<void> };

/** What @electric-sql/pglite ~0.5 writes to PG_VERSION; bump it together with the PGlite pin. */
const PG_MAJOR = "18";

/** The URL of the local database served on `port`. */
export const localUrl = (port: number) => `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

function paths(dir: string) {
  const revbound = join(realpathSync(dir), ".revbound");
  return { revbound, lock: join(revbound, "db.lock"), id: join(revbound, "db.id"), data: join(revbound, "pglite"), version: join(revbound, "pglite-version") };
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const read = (file: string) => { try { return readFileSync(file, "utf8").trim(); } catch { return undefined; } };
const parse = (text: string | undefined): Lock | undefined => { try { return JSON.parse(text ?? ""); } catch { return undefined; } };
/** True while process `pid` exists (EPERM: it does, under another user). */
export const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const release = (file: string) => { if (parse(read(file))?.pid === process.pid) unlinkSync(file); };
/** True when something accepts TCP connections on 127.0.0.1:`port`. */
export const accepts = (port: number) =>
  new Promise<boolean>((done) => {
    if (!port) return done(false);
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
  });

/** Creates `file` holding `body` (exclusive), first clearing it when `stale` says its holder is gone. */
function take(file: string, body: object, stale: (lock: Lock) => boolean): boolean {
  for (let tries = 0; tries < 3; tries += 1) {
    try { writeFileSync(file, JSON.stringify(body), { flag: "wx" }); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const text = read(file);
    const lock = parse(text);
    if (!lock || !stale(lock)) return false;
    const grabbed = `${file}.${process.pid}`; // rename first, so only that exact stale file is removed
    try { renameSync(file, grabbed); } catch { continue; }
    if (read(grabbed) !== text) try { linkSync(grabbed, file); } catch {} // a fresh lock raced in: put it back
    unlinkSync(grabbed);
  }
  return false;
}

/**
 * The database a Revbound command uses: DATABASE_URL when set; else the live `revbound dev` server (after checking that it
 * serves this project's database); else a short-lived local server of its own, stopped when `fn` settles.
 */
export async function withDatabase<T>(dir: string, fn: (url: string) => Promise<T>): Promise<T> {
  const url = value("DATABASE_URL");
  if (url) return fn(url);
  const live = await acquire(dir, true);
  if (live) return checkId(dir, live.port).then(() => fn(localUrl(live.port)));
  const local = await serve(dir, false);
  try { return await fn(local.url); } finally { await local.stop(); }
}

/** Takes the lock and serves the local database for `revbound dev`; refuses while another `revbound dev` serves it. */
export async function startDevDatabase(dir: string): Promise<LocalDatabase> {
  await acquire(dir, false);
  return serve(dir, true);
}

/** Runs `fn` holding `.revbound/migrate.lock`: on PGlite every connection shares one session, so advisory locks never block. */
export async function withMigrateLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const file = join(paths(dir).revbound, "migrate.lock");
  mkdirSync(dirname(file), { recursive: true });
  for (const deadline = Date.now() + 120_000; !take(file, { pid: process.pid }, (l) => !alive(l.pid)); await sleep(100)) {
    if (Date.now() > deadline) throw new Error("Another revbound migrate holds .revbound/migrate.lock; delete it only if no Revbound process is running.");
  }
  try { return await fn(); } finally { release(file); }
}

/** Takes `.revbound/db.lock` (returns undefined), or with `share` returns a live `revbound dev` lock. */
async function acquire(dir: string, share: boolean): Promise<Lock | undefined> {
  const p = paths(dir);
  mkdirSync(p.revbound, { recursive: true });
  for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
    // Stale: its process is gone, or the project folder was copied with its .revbound/.
    if (take(p.lock, { pid: process.pid, port: 0, dataDir: p.data }, (l) => !alive(l.pid) || l.dataDir !== p.data)) return undefined;
    const lock = parse(read(p.lock));
    if (lock?.dev && (await accepts(lock.port))) {
      if (share) return lock;
      throw new Error(`revbound dev is already running for this project (pid ${lock.pid}, database on 127.0.0.1:${lock.port}).`);
    }
    if (Date.now() > deadline) throw new Error(`Another Revbound process${lock ? ` (pid ${lock.pid})` : ""} holds .revbound/db.lock. Wait for it to finish; delete .revbound/db.lock only if no Revbound process is running.`);
  }
}

/** Opens `.revbound/pglite` and serves it on a free 127.0.0.1 port (at most 10 sockets); the caller holds the lock. */
async function serve(dir: string, dev: boolean): Promise<LocalDatabase> {
  const p = paths(dir);
  try {
    const found = read(join(p.data, "PG_VERSION"));
    if (found && found !== PG_MAJOR) refuseOtherMajor(found, read(p.version));
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketHandler } = await import("@electric-sql/pglite-socket");
    const db = await PGlite.create(p.data);
    if (!found) writeFileSync(p.version, `${versionOf("@electric-sql/pglite")} ${versionOf("@electric-sql/pglite-socket")}\n`);
    // Same DDL as migrations/0000 (idempotent with it), so the local id exists before any migration runs.
    await db.exec("create schema if not exists revbound; create table if not exists revbound.meta (key text primary key not null, value text not null);");
    await db.query("insert into revbound.meta (key, value) values ('local_id', $1) on conflict (key) do nothing", [read(p.id) || randomBytes(16).toString("hex")]);
    const id = (await db.query<{ value: string }>("select value from revbound.meta where key = 'local_id'")).rows[0].value;
    if (read(p.id) !== id) writeFileSync(p.id, `${id}\n`);
    const queue = queueFor(db);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      if (sockets.size >= 10) return void socket.destroy(); // end() would leave it half-open, holding up stop()
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      new PGLiteSocketHandler({ queryQueue: queue as never, closeOnDetach: true }).attach(socket).catch(() => socket.destroy());
    });
    await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    writeFileSync(`${p.lock}.tmp${process.pid}`, JSON.stringify({ pid: process.pid, port, dataDir: p.data, ...(dev && { dev }) }));
    renameSync(`${p.lock}.tmp${process.pid}`, p.lock);
    return {
      url: localUrl(port),
      async stop() {
        for (const socket of sockets) socket.destroy();
        await new Promise((done) => server.close(done));
        await db.close();
        release(p.lock);
      },
    };
  } catch (error) {
    release(p.lock);
    throw error;
  }
}

/**
 * The queue PGLiteSocketHandler runs messages through. pglite-socket's own one interleaves extended-protocol
 * messages across connections, so a connection owns the database from its first extended-protocol
 * message until Sync, and for as long as it is inside a transaction.
 */
function queueFor(db: PGlite) {
  const EXTENDED = new Set([..."PBDECHFdcf"].map((c) => c.charCodeAt(0)));
  type Item = { handlerId: number; message: Uint8Array; onData: (data: Uint8Array) => void; resolve: (n: number) => void; reject: (e: unknown) => void };
  let items: Item[] = [];
  let owner: number | null = null;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const i = owner === null ? (items.length ? 0 : -1) : items.findIndex((q) => q.handlerId === owner);
        if (i === -1) break;
        const [q] = items.splice(i, 1);
        try {
          await db.runExclusive(() => db.execProtocolRawStream(q.message, { onRawData: q.onData }));
          owner = EXTENDED.has(q.message[0]) || db.isInTransaction() ? q.handlerId : null;
          q.resolve(0);
        } catch (error) {
          owner = null; // a failed message ends the exchange; the handler closes that connection
          q.reject(error);
        }
      }
    } finally {
      busy = false;
    }
  };
  return {
    enqueue: (handlerId: number, message: Uint8Array, onData: Item["onData"]) =>
      new Promise<number>((resolve, reject) => { items.push({ handlerId, message, onData, resolve, reject }); void run(); }),
    clearQueueForHandler(id: number) {
      items = items.filter((q) => q.handlerId !== id || (q.reject(new Error("Handler disconnected")), false));
    },
    async clearTransactionIfNeeded(id: number) {
      if (owner !== id) return;
      if (db.isInTransaction()) await db.exec("ROLLBACK");
      owner = null;
      void run();
    },
  };
}

/** Refuses a data folder from another Postgres major (another PGlite major), printing how to carry the data over. */
function refuseOtherMajor(found: string, written: string | undefined): never {
  const [pglite, socket] = written?.split(/\s+/) ?? [];
  throw new Error([
    `.revbound/pglite holds a Postgres ${found} database${pglite ? ` (PGlite ${pglite})` : ""}; this Revbound's PGlite ${versionOf("@electric-sql/pglite")} runs Postgres ${PG_MAJOR} and cannot open it.`,
    "It is development data. To start fresh: rm -rf .revbound/pglite .revbound/pglite-version",
    "To keep it, dump it with the old version, then restore it into a new database:",
    `  npx -y @electric-sql/pglite-socket@${socket ?? `<the version for Postgres ${found}>`} --db=.revbound/pglite --port=54329   (stop it after the dump)`,
    `  pg_dump --data-only --exclude-schema=revbound --exclude-schema=drizzle "${localUrl(54329)}" > local.sql`,
    "  mv .revbound/pglite .revbound/pglite-old && rm .revbound/pglite-version && npm run dev   (new database, migrations applied)",
    '  psql "<the DATABASE_URL `npx revbound check` prints>" -f local.sql',
  ].join("\n"));
}

/** Refuses a live server whose `revbound.meta` local_id differs from `.revbound/db.id` (not this project's database). */
async function checkId(dir: string, port: number): Promise<void> {
  const client = new pg.Client({ connectionString: localUrl(port) });
  await client.connect();
  const rows = await client.query("select value from revbound.meta where key = 'local_id'")
    .then((r) => r.rows, () => []).finally(() => client.end());
  if (!rows[0] || rows[0].value !== read(paths(dir).id)) {
    throw new Error(`The database on 127.0.0.1:${port} named in .revbound/db.lock is not this project's (.revbound/db.id differs). Stop the revbound dev serving it; delete .revbound/db.lock only if no Revbound process is running.`);
  }
}

/** The installed version of a dependency (its package.json is not exported, so walk up from its entry). */
function versionOf(name: string): string {
  for (let d = dirname(fileURLToPath(import.meta.resolve(name))); d !== dirname(d); d = dirname(d)) {
    const pkg = read(join(d, "package.json"));
    if (pkg && JSON.parse(pkg).name === name) return JSON.parse(pkg).version;
  }
  return "unknown";
}
