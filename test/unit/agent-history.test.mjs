/**
 * The console chat's history: each chat answers only the person who started it, on every eve session route, through
 * eve's real channel (from the build) with people told apart by Vercel's login cookie; the store's SQL on PGlite.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { ForbiddenError } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const dist = (file) => import(new URL(`../../dist/plugins/agent/${file}.js`, import.meta.url).href);
const { consoleCaller } = await dist("access");
const { chatStore, ownChats, titleOf } = await dist("history");

/** The fail-closed refusals logged during the run; kept off the test output. */
const errors = [];
console.error = (...args) => errors.push(args.map(String).join(" "));

const HOSTED = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test" };
const ORIGIN = "https://revbound-acme.vercel.app";
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
// The login cookie as Vercel sets it (its claims as read from a live deployment).
const login = (userId) => jwt({ userId, sub: "sso-protection", ownerId: "team_acme", aud: new URL(ORIGIN).hostname, username: userId });
const ANN = login("user_ann"), BOB = login("user_bob");

/** The console's auth as console.ts builds it, on a hosted deployment. */
const auth = (req) => {
  const caller = consoleCaller(req, HOSTED);
  if (!caller.ok) throw new ForbiddenError({ message: caller.error });
  return { authenticator: "revbound-console", principalType: "user", principalId: caller.principalId, attributes: caller.attributes };
};

/** An in-memory store with the same rules as the SQL one; `broken` makes every call fail. */
function memoryStore() {
  const rows = new Map();
  const s = {
    broken: false,
    rows,
    check() { if (s.broken) throw new Error("database down"); },
    async claim(id, owner, title) { s.check(); if (!rows.has(id)) rows.set(id, { owner, title: title ?? "", updatedAt: new Date().toISOString() }); return rows.get(id).owner === owner; },
    async owns(id, owner) { s.check(); return rows.get(id)?.owner === owner; },
    async touch(id, owner, title) { s.check(); const r = rows.get(id); if (r?.owner === owner) Object.assign(r, { updatedAt: new Date().toISOString(), title: r.title || title || "" }); },
    async list(owner) { s.check(); return [...rows].filter(([, r]) => r.owner === owner).map(([id, r]) => ({ id, title: r.title, updatedAt: r.updatedAt })).reverse(); },
    async remove(id, owner) { s.check(); return rows.get(id)?.owner === owner && rows.delete(id); },
  };
  return s;
}

/** eve's real console channel, held to owners, with the session runtime faked: every session call is recorded. */
function setup() {
  const store = memoryStore(), calls = [];
  let next = 0;
  const base = eveChannel({ auth: [auth] });
  // The create route needs eve's internal dispatch context; stand in for it with what it returns.
  base.routes = base.routes.map((r) => (r.method === "POST" && r.path === "/eve/v1/session" ? { ...r, handler: async (req) => {
    try { await auth(req); } catch (e) { return Response.json({ ok: false, error: e.message }, { status: 403 }); }
    const sessionId = `wrun_${++next}`;
    calls.push(["create", sessionId]);
    return Response.json({ ok: true, sessionId, status: "accepted" }, { status: 202, headers: { "x-eve-session-id": sessionId } });
  } } : r));
  const channel = ownChats(base, auth, store);
  const session = (id) => new Proxy({}, { get: (_, method) => async () => { calls.push([String(method), id]); return method === "getEventStream" ? new ReadableStream({ start: (c) => c.close() }) : { status: "accepted", sessionId: id }; } });
  const call = async (who, method, path, body) => {
    const route = channel.routes.find((r) => r.method === method && match(r.path, path));
    assert.ok(route, `${method} ${path}`);
    const headers = { host: new URL(ORIGIN).host, origin: ORIGIN, "sec-fetch-site": "same-origin", ...(who && { cookie: `_vercel_jwt=${who}` }), ...(body && { "content-type": "application/json" }) };
    const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body && { body: JSON.stringify(body) }) });
    return route.handler(req, { params: match(route.path, path), attachSession: (id) => { calls.push(["attach", id]); return session(id); }, waitUntil: () => {} });
  };
  return { store, calls, call };
}

/** The params of `path` under route pattern `pattern`, or undefined. */
function match(pattern, path) {
  const p = pattern.split("/"), a = path.split("?")[0].split("/");
  if (p.length !== a.length) return undefined;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return undefined;
  }
  return params;
}

const SESSION_ROUTES = (id) => [
  ["POST", `/eve/v1/session/${id}`, { message: "Show me Bob's pipeline" }],
  ["POST", `/eve/v1/session/${id}`, { inputResponses: [{ requestId: "req_1", optionId: "approve" }] }],
  ["POST", `/eve/v1/session/${id}`, {}],
  ["GET", `/eve/v1/session/${id}/stream`],
  ["POST", `/eve/v1/session/${id}/cancel`, {}],
  ["POST", `/eve/v1/session/${id}/clear`, {}],
  ["POST", `/eve/v1/session/${id}/compact`, {}],
  ["POST", `/eve/v1/session/${id}/reset`, {}],
  ["GET", `/eve/v1/session/${id}/stubs`],
  ["GET", `/eve/v1/session/${id}/subagents/call_1/wrun_child/stream`],
  ["DELETE", `/eve/v1/chats/${id}`],
];

test("every eve route that names a session is held to its owner (none is missed)", async () => {
  const { eveChannel: fresh } = await import("eve/channels/eve");
  const named = fresh({ auth: [] }).routes.filter((r) => /:(sessionId|parentSessionId)\b/.test(r.path)).map((r) => `${r.method} ${r.path}`);
  const covered = new Set(SESSION_ROUTES("wrun_x").map(([m, p]) => `${m} ${p.replace("wrun_x", ":sessionId").replace("/:sessionId/subagents/call_1/wrun_child/", "/:parentSessionId/subagents/:callId/:childSessionId/")}`));
  for (const route of named) assert.ok(covered.has(route), `${route} is not tested`);
});

test("two people: each lists and opens only their own chats; the other's id is refused on every route", async () => {
  const { store, calls, call } = setup();
  const created = await call(ANN, "POST", "/eve/v1/session", { message: "Draft an outbound   workflow\nfor Acme" });
  assert.equal(created.status, 202);
  const { sessionId: annChat } = await created.json();
  assert.deepEqual(store.rows.get(annChat), { owner: "vercel:user_ann", title: "Draft an outbound workflow for Acme", updatedAt: store.rows.get(annChat).updatedAt });
  const bobChat = (await (await call(BOB, "POST", "/eve/v1/session", { message: "Hi" })).json()).sessionId;

  const list = async (who) => (await (await call(who, "GET", "/eve/v1/chats")).json()).chats.map((c) => c.id);
  assert.deepEqual(await list(ANN), [annChat]);
  assert.deepEqual(await list(BOB), [bobChat]);

  for (const [method, path, body] of SESSION_ROUTES(annChat)) {
    calls.length = 0;
    const res = await call(BOB, method, path, body);
    assert.equal(res.status, 404, `Bob ${method} ${path}`);
    assert.deepEqual(calls, [], `Bob's ${method} ${path} never reached Ann's session`);
  }
  // A Slack or Teams thread, or any id the console did not create, is refused the same way.
  for (const [method, path, body] of SESSION_ROUTES("wrun_slack_thread")) assert.equal((await call(ANN, method, path, body)).status, 404, `${method} ${path}`);
  assert.ok(store.rows.has(annChat), "Bob's delete left Ann's chat alone");

  // Ann reaches her own chat on every route.
  for (const [method, path, body] of SESSION_ROUTES(annChat).slice(0, -1)) {
    calls.length = 0;
    const res = await call(ANN, method, path, body);
    if (path.endsWith("/stubs")) { assert.equal(res.status, 403, "eve refuses stubs to everyone here"); continue; }
    if (path.includes("/subagents/")) { assert.equal(res.status, 404, "no such subagent"); assert.ok(calls.some(([, id]) => id === annChat)); continue; }
    assert.ok(res.status < 300, `Ann ${method} ${path}: ${res.status} ${await res.clone().text()}`);
    assert.ok(calls.some(([, id]) => id === annChat), `Ann ${method} ${path} reached her session`);
  }
  assert.equal((await call(ANN, "DELETE", `/eve/v1/chats/${annChat}`)).status, 200);
  assert.deepEqual(await list(ANN), []);
  assert.equal((await call(ANN, "GET", `/eve/v1/session/${annChat}/stream`)).status, 404, "a deleted chat opens for no one");
});

test("no identity, no chats: a missing or doubled Vercel login is refused; a broken database refuses too", async () => {
  const { store, calls, call } = setup();
  const annChat = (await (await call(ANN, "POST", "/eve/v1/session", { message: "Hi" })).json()).sessionId;
  calls.length = 0;
  const forged = jwt({ ...JSON.parse(Buffer.from(ANN.split(".")[1], "base64url")), userId: "user_bob" });
  for (const who of [undefined, jwt({ sub: "sso-protection" }), `${forged}; _vercel_jwt=${ANN}`, `${ANN}; _vercel_jwt=${forged}`, jwt({ sub: "sso-protection", email: "ann@example.com" })]) {
    assert.equal((await call(who, "GET", "/eve/v1/chats")).status, 403, `list as ${who}`);
    assert.equal((await call(who, "GET", `/eve/v1/session/${annChat}/stream`)).status, 403, `stream as ${who}`);
    assert.equal((await call(who, "POST", "/eve/v1/session", { message: "Hi" })).status, 403, `create as ${who}`);
  }
  assert.deepEqual(calls, []);
  store.broken = true;
  assert.equal((await call(ANN, "GET", "/eve/v1/chats")).status, 503);
  assert.equal((await call(ANN, "GET", `/eve/v1/session/${annChat}/stream`)).status, 503);
  const made = await call(ANN, "POST", "/eve/v1/session", { message: "Hi" });
  assert.equal(made.status, 503, "a chat that cannot be saved is not handed out");
  assert.deepEqual(calls.filter(([m]) => m === "reset").length, 1, "and it is ended");
});

test("chat titles: the first message's text on one line, else a file's name", () => {
  assert.equal(titleOf("  Find   leads\nin Sweden "), "Find leads in Sweden");
  assert.equal(titleOf([{ type: "file", filename: "report.pdf" }, { type: "text", text: "Summarize" }]), "Summarize");
  assert.equal(titleOf([{ type: "file", filename: "report.pdf" }]), "report.pdf");
  assert.equal(titleOf("x".repeat(200)).length, 80);
  assert.equal(titleOf(undefined), undefined);
});

test("the chats table: owners never see or change each other's rows", async () => {
  const pg = new PGlite(), dialect = new PgDialect();
  await pg.exec(`create schema revbound_agent; ${fs.readFileSync(new URL("../../src/plugins/agent/migrations/0000_chats.sql", import.meta.url), "utf8")}`);
  const store = chatStore(async (q) => { const { sql, params } = dialect.sqlToQuery(q); return (await pg.query(sql, params)).rows; });
  assert.equal(await store.claim("wrun_a", "vercel:ann", "Ann's"), true);
  assert.equal(await store.claim("wrun_a", "vercel:ann"), true, "claiming your own again is fine");
  assert.equal(await store.claim("wrun_a", "vercel:bob", "Bob's"), false, "someone else's id stays theirs");
  await store.claim("wrun_b", "vercel:ann");
  await store.touch("wrun_b", "vercel:ann", "Later title");
  await store.touch("wrun_a", "vercel:bob", "Hijack");
  assert.deepEqual((await store.list("vercel:ann")).map((c) => [c.id, c.title]), [["wrun_b", "Later title"], ["wrun_a", "Ann's"]]);
  assert.deepEqual(await store.list("vercel:bob"), []);
  assert.equal(await store.owns("wrun_a", "vercel:bob"), false);
  assert.equal(await store.remove("wrun_a", "vercel:bob"), false);
  assert.equal(await store.remove("wrun_a", "vercel:ann"), true);
  assert.equal(await store.owns("wrun_a", "vercel:ann"), false);
  await pg.close();
});
