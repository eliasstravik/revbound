/** The local database `revbound dev` serves: many connections at once (parallel lanes) stay in step with the one PGlite session. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { connect } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { serialize } from "pg-protocol";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
let server, url;
before(async () => {
  server = fork(fileURLToPath(new URL("../fixtures/localdb-server.mjs", import.meta.url)), [REPO]);
  url = await new Promise((done, fail) => server.once("message", done).once("exit", (code) => fail(new Error(`the database exited (${code})`))));
});
after(() => server?.disconnect());

/** A raw protocol connection: `send` writes messages, `take` returns the message types received since the last take. */
async function raw() {
  const { port } = new URL(url), socket = connect(Number(port), "127.0.0.1");
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); });
  // Message types, leaving out ParameterStatus and notices.
  const types = () => { const out = []; for (let i = 0; i + 5 <= buf.length; i += 1 + buf.readInt32BE(i + 1)) out.push(String.fromCharCode(buf[i])); return out.join("").replace(/[SN]/g, ""); };
  const settle = async () => { for (let last = -1; last !== buf.length; ) { last = buf.length; await new Promise((r) => setTimeout(r, 150)); } };
  const take = async () => { await settle(); const t = types(); buf = Buffer.alloc(0); return t; };
  await new Promise((done) => socket.once("connect", done));
  socket.write(serialize.startup({ user: "postgres", database: "postgres" }));
  assert.match(await take(), /Z$/, "the startup ends ready");
  return { send: (...msgs) => socket.write(Buffer.concat(msgs)), take, close: () => socket.destroy() };
}
const batch = (text, values = []) => [serialize.parse({ text }), serialize.bind({ values }), serialize.describe({ type: "P" }), serialize.execute({}), serialize.sync()];

test("a query that fails answers ready once, at its Sync", async () => {
  const c = await raw();
  c.send(...batch("select $1::int", ["not-a-number"]));
  assert.equal(await c.take(), "1EZ", "parse, the error, then one ReadyForQuery");
  c.send(serialize.query("select 1"));
  assert.equal(await c.take(), "TDCZ", "the next query gets its own answer");
  c.close();
});

test("11 parallel lanes whose transactions conflict and roll back never get another query's answer", async () => {
  const pool = new pg.Pool({ connectionString: url, max: 3 }), errors = [];
  pool.on("error", (e) => errors.push(e.message));
  await pool.query("create table lead (id serial primary key, domain text unique)");
  let committed = 0, conflicts = 0;
  await Promise.all(Array.from({ length: 11 }, async () => {
    for (let i = 0; i < 20; i += 1) {
      const client = await pool.connect(), onError = (e) => errors.push(e.message);
      client.on("error", onError);
      let broken;
      try {
        await client.query("begin");
        await client.query("insert into lead (domain) values ($1)", [`d${i}.example`]); // the lanes race for the same domains
        await client.query("commit");
        committed += 1;
      } catch (e) {
        if (/duplicate key/.test(e.message)) conflicts += 1; else { errors.push(e.message); broken = e; }
        await client.query("rollback").catch((e2) => { errors.push(e2.message); broken = e2; });
      } finally {
        client.off("error", onError);
        client.release(broken);
      }
    }
  }));
  const rows = Number((await pool.query("select count(*) from lead")).rows[0].count);
  await pool.end();
  assert.deepEqual(errors, []);
  assert.equal(committed, 20, "each domain committed once");
  assert.equal(conflicts, 200);
  assert.equal(rows, 20);
});

test("a connection that closes mid-exchange leaves nothing behind for the next one", async () => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("create table note (k text)");
  // One closes after its insert ran but before its Sync; another after an error, before its Sync.
  const a = await raw();
  a.send(serialize.parse({ text: "insert into note values ('half')" }), serialize.bind({}), serialize.execute({}), serialize.flush());
  await a.take();
  a.close();
  const b = await raw();
  b.send(serialize.parse({ text: "selec 1" }), serialize.flush());
  assert.equal(await b.take(), "E");
  b.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await client.query("select $1::int as n", [7])).rows, [{ n: 7 }], "the next query is answered");
  assert.equal((await client.query("select count(*)::int as n from note")).rows[0].n, 0, "the unfinished insert was rolled back");
  await client.end();
});
