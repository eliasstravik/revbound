/** Access modes, hosted and local, through the proxy and the route shim (against the build: `npm run build` first). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { revboundProxy } from "../../dist/core/proxy.js";
import { revboundRoutes } from "../../dist/core/server.js";
import { brand } from "../../dist/kit/brand.js";
import { loadFresh } from "../../dist/kit/ctx.js";
import { bySpecificity, find, match, sameShape } from "../../dist/kit/patterns.js";

const AUTOMATION = "automation-secret-0123456789abcdef";
const STRIPE = "stripe-sender-secret-0123456789ab";
const HOSTED = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test", VERCEL_AUTOMATION_BYPASS_SECRET: AUTOMATION, REVBOUND_HOOK_STRIPE_BYPASS: STRIPE,
  REVBOUND_HOOK_GITHUB_BYPASS: "github-sender-secret-0123456789", CRON_SECRET: "cron-secret" };
const VARS = ["VERCEL_ENV", "VERCEL_DEPLOYMENT_ID", "VERCEL_AUTOMATION_BYPASS_SECRET", "REVBOUND_HOOK_STRIPE_BYPASS", "REVBOUND_HOOK_GITHUB_BYPASS", "CRON_SECRET",
  "REVBOUND_ALLOWED_HOSTS", "NODE_ENV", "REVBOUND_DEV", "REVBOUND_BASE_PATH"];

const route = (path, methods, access, extra = {}) => ({ path, methods, access, plugin: "p", key: `p:${path}`, ...extra });
const manifest = {
  api: 1, version: "0", company: "Acme", plugins: [], slots: {}, views: [], tabs: [], connections: [], tables: [],
  acknowledge: { customLedger: false, destructive: [] },
  routes: [
    route("shell", ["GET"], "session"), route("runs/:id", ["GET"], "automation"), route("runs/export", ["GET"], "session"),
    route("start/:name", ["POST"], "automation"), route("cron/:name", ["GET"], "cron"), route("inspector/*", ["GET", "POST"], "local"),
    route("hooks/:name", ["POST"], "signature", { secret: "REVBOUND_HOOK_{name}_BYPASS" }), route("shared", ["GET"], "session"), route("db/open", ["POST"], "tailnet"), route("shared", ["POST"], "automation", { key: "q:shared" }), route("unbranded/:name", ["POST"], "signature", { secret: "X_{name}" }),
  ],
};

/** Runs fn with exactly `env` of VARS set, and a probe that says Vercel's login is on. */
async function withEnv(env, fn) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]])), fetch = globalThis.fetch;
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async () => new Response("Authentication Required", { status: 401 });
  try { return await fn(); } finally {
    globalThis.fetch = fetch;
    for (const k of VARS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}
const req = (path, { method = "GET", host = "127.0.0.1:3000", headers = {} } = {}) =>
  new Request(`http://${host}${path}`, { method, headers: { host, ...headers } });
const proxy = revboundProxy(manifest);
/** The proxy's status for a request: 200 when it lets it through. */
const status = async (r) => (await proxy(r))?.status ?? 200;
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

test("patterns: a fixed segment beats a parameter; only same-shape patterns conflict", () => {
  assert.deepEqual(match("runs/:id", ["runs", "abc"]), { id: "abc" });
  assert.equal(match("runs/:id", ["runs"]), null);
  assert.deepEqual(match("inspector/*", ["inspector", "run", "x"]), { "*": "run/x" });
  assert.equal(find(manifest.routes, ["runs", "export"]).item.path, "runs/export");
  assert.equal(find(manifest.routes, ["runs", "r1"]).item.path, "runs/:id");
  assert.ok(bySpecificity("runs/export", "runs/:id") < 0);
  assert.ok(sameShape("a/:x", "a/:y") && !sameShape("runs/export", "runs/:id") && !sameShape("a/:x/c", "a/b/:y"));
});

test("local: loopback and allowed hosts read; cross-site POSTs, unknown hosts and undeclared /api paths are refused", () => withEnv({ REVBOUND_ALLOWED_HOSTS: "box.tail1234.ts.net" }, async () => {
  assert.equal(await status(req("/")), 200);
  assert.equal(await status(req("/icon.svg")), 200, "static files fall under the page rule");
  assert.equal(await status(req("/workflows", { host: "box.tail1234.ts.net" })), 200);
  assert.equal(await status(req("/", { host: "evil.test" })), 403);
  assert.equal(await status(req("/api/revbound/nothing")), 404);
  assert.equal(await status(req("/api/other")), 404);
  assert.equal(await status(req("/api/revbound/shell", { method: "POST" })), 405);
  assert.equal(await status(req("/api/revbound/start/x", { method: "POST" })), 200);
  assert.equal(await status(req("/api/revbound/start/x", { method: "POST", headers: { origin: "http://evil.test" } })), 403, "cross-site POST to automation");
  assert.equal(await status(req("/api/revbound/start/x", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })), 403);
  assert.equal(await status(req("/api/revbound/start/x", { method: "POST", host: "box.tail1234.ts.net" })), 403, "automation is loopback only locally");
  assert.equal(await status(req("/api/revbound/inspector/run/x", { host: "box.tail1234.ts.net" })), 403, "a local route refuses allowed hosts");
  assert.equal(await status(req("/api/revbound/inspector/run/x", { headers: { "x-forwarded-host": "box.tail1234.ts.net" } })), 403);
  assert.equal(await status(req("/api/revbound/cron/x")), 401, "cron needs CRON_SECRET, refused when unset");
  assert.equal(await status(req("/.well-known/workflow/v1/flow", { host: "box.tail1234.ts.net" })), 404);
  assert.equal(await status(req("/api/revbound/shared")), 200, "GET reaches the GET declaration");
  assert.equal(await status(req("/api/revbound/shared", { method: "POST" })), 200, "POST reaches the POST declaration at the same path");
  assert.equal(await status(req("/api/revbound/shared", { method: "POST", host: "box.tail1234.ts.net" })), 403, "with that route's own access mode");
}));

test("tailnet: loopback, or a same-origin request Tailscale Serve marks with a login on an allowed host; never Funnel or hosted", () => withEnv({ REVBOUND_ALLOWED_HOSTS: "box.tail1234.ts.net" }, async () => {
  const BOX = "box.tail1234.ts.net", login = { "tailscale-user-login": "person@example.com" };
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST" })), 200);
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: BOX, headers: { ...login, origin: `https://${BOX}` } })), 200);
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: BOX })), 403, "no login");
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: BOX, headers: { ...login, "tailscale-funnel-request": "?1" } })), 403, "Funnel");
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: BOX, headers: { ...login, origin: "https://evil.test" } })), 403, "cross-site");
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: "evil.test", headers: login })), 403, "a host not allowed");
  assert.equal(await status(req("/api/revbound/inspector/run/x", { host: BOX, headers: login })), 403, "local routes stay loopback only");
}));

test("a base path: routes and pages are matched below it", () => withEnv({ REVBOUND_BASE_PATH: "/acme" }, async () => {
  assert.equal(await status(req("/acme/api/revbound/start/x", { method: "POST" })), 200);
  assert.equal(await status(req("/acme/api/revbound/nothing")), 404);
  assert.equal(await status(req("/acme/api/revbound/shell", { method: "POST" })), 405);
  assert.equal(await status(req("/acme/workflows", { host: "evil.test" })), 403);
  assert.equal(await status(req("/acme")), 200);
}));

test("hosted: pages and session routes refuse every bypass credential", () => withEnv(HOSTED, async () => {
  assert.equal(await status(req("/api/revbound/db/open", { method: "POST", host: "revbound-acme.vercel.app", headers: { "tailscale-user-login": "person@example.com" } })), 404, "tailnet routes are local");
  const host = "revbound-acme.example.com";
  assert.equal(await status(req("/", { host })), 200);
  assert.equal(await status(req("/icon.svg", { host })), 200);
  assert.equal(await status(req("/api/revbound/shell", { host })), 200);
  for (const path of ["/", "/data", "/api/revbound/shell", "/api/revbound/runs/export"]) {
    assert.equal(await status(req(path, { host, headers: { "x-vercel-protection-bypass": AUTOMATION } })), 403, `${path}: automation secret`);
    assert.equal(await status(req(path, { host, headers: { "x-vercel-protection-bypass": STRIPE } })), 403, `${path}: a sender's secret`);
    assert.equal(await status(req(`${path}?x-vercel-protection-bypass=${STRIPE}`, { host })), 403, `${path}: a sender's secret as a query parameter`);
    assert.equal(await status(req(path, { host, headers: { cookie: `_vercel_jwt=${jwt({ bypass: "x", sub: "protection-bypass-automation" })}` } })), 403, `${path}: a bypass JWT`);
  }
  assert.equal(await status(req("/api/revbound/nothing", { host })), 404);
}));

test("hosted: automation takes only the automation secret in the header; signature only its own sender's secret", () => withEnv(HOSTED, async () => {
  const host = "revbound-acme.example.com", post = (path, headers, q = "") => status(req(`${path}${q}`, { method: "POST", host, headers }));
  assert.equal(await post("/api/revbound/start/x", { "x-vercel-protection-bypass": AUTOMATION }), 200);
  assert.equal(await post("/api/revbound/start/x", {}), 403);
  assert.equal(await post("/api/revbound/start/x", { "x-vercel-protection-bypass": STRIPE }), 403, "a sender's secret on an automation route");
  assert.equal(await post("/api/revbound/start/x", {}, `?x-vercel-protection-bypass=${AUTOMATION}`), 403, "the automation secret as a query parameter");
  assert.equal(await post("/api/revbound/hooks/stripe", { "x-vercel-protection-bypass": STRIPE }), 200);
  assert.equal(await post("/api/revbound/hooks/stripe", {}, `?x-vercel-protection-bypass=${STRIPE}`), 200, "the sender's secret as a query parameter");
  assert.equal(await post("/api/revbound/hooks/stripe", { "x-vercel-protection-bypass": AUTOMATION }), 403, "the automation secret on a signature route");
  assert.equal(await post("/api/revbound/hooks/github", { "x-vercel-protection-bypass": STRIPE }), 403, "a sender's secret on another sender's route");
  assert.equal(await post("/api/revbound/hooks/nobody", { "x-vercel-protection-bypass": STRIPE }), 403, "a sender with no secret configured");
  assert.equal(await post("/api/revbound/inspector/x", {}), 404, "local routes are not hosted");
  assert.equal(await status(req("/api/revbound/cron/x", { host, headers: { authorization: "Bearer cron-secret" } })), 200);
  assert.equal(await status(req("/api/revbound/cron/x", { host, headers: { authorization: "Bearer nope" } })), 401);
}));

test("hosted fail-closed: an anonymous probe that gets through closes pages and session routes, not self-authenticating ones", () => withEnv(HOSTED, async () => {
  globalThis.fetch = async () => new Response("revbound-probe-v1", { status: 200 });
  const host = "revbound-open.example.com";
  assert.equal(await status(req("/", { host })), 503);
  assert.equal(await status(req("/api/revbound/shell", { host })), 503);
  assert.equal(await status(req("/api/revbound/cron/x", { host, headers: { authorization: "Bearer cron-secret" } })), 200);
  assert.equal(await status(req("/api/revbound/start/x", { method: "POST", host, headers: { "x-vercel-protection-bypass": AUTOMATION } })), 200);
}));

test("route shim: the access check again, an unbranded signature handler answers 500, a branded one runs", () => withEnv({}, async () => {
  const ok = () => new Response("ok");
  const map = { default: { plugin: "p", slots: {}, modules: {} } };
  const handlers = Object.fromEntries(manifest.routes.map((r) => [r.key, { load: async () => ({ default: r.path.startsWith("hooks") ? brand(ok) : ok }), map: async () => map }]));
  const { GET, POST } = revboundRoutes(manifest, handlers);
  const call = (fn, path, init) => fn(req(`/api/revbound/${path}`, init), { params: Promise.resolve({ path: path.split("/") }) });
  assert.equal((await call(POST, "unbranded/x", { method: "POST" })).status, 500);
  assert.equal((await call(POST, "hooks/stripe", { method: "POST" })).status, 200);
  assert.equal((await call(GET, "shell")).status, 200);
  assert.equal((await call(GET, "shell")).headers.get("cache-control"), "no-store");
  assert.equal((await call(POST, "start/x", { method: "POST", headers: { origin: "http://evil.test" } })).status, 403);
  assert.equal((await call(GET, "nothing")).status, 404);
  handlers["q:shared"] = { load: async () => ({ default: () => new Response("post") }), map: async () => map };
  assert.equal(await (await call(GET, "shared")).text(), "ok", "GET runs the GET declaration");
  assert.equal(await (await call(POST, "shared", { method: "POST" })).text(), "post", "POST runs the POST declaration at the same path");
}));

test("loadFresh: a chunk load that raced a next dev rebuild clears Turbopack's chunk cache and retries; other errors throw", async () => {
  const chunkError = () => Object.assign(new Error("Failed to load chunk"), { name: "ChunkLoadError" });
  let tries = 0, cleared = 0;
  const flaky = async () => { tries += 1; if (tries < 3) throw chunkError(); return "loaded"; };
  await assert.rejects(loadFresh(flaky), { name: "ChunkLoadError" }, "outside next dev (no cache to clear) it throws at once");
  globalThis.__next__clear_chunk_cache__ = () => { cleared += 1; };
  try {
    tries = 0;
    assert.equal(await loadFresh(flaky), "loaded");
    assert.deepEqual([tries, cleared], [3, 2]);
    await assert.rejects(loadFresh(async () => { throw new Error("syntax"); }), /syntax/);
  } finally { delete globalThis.__next__clear_chunk_cache__; }
});
