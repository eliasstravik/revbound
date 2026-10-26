/** Connections: the local files, the console access mode, and hosted changes against a stand-in Vercel API (`npm run build` first). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { routeAccess } from "../../dist/kit/access.js";
import { refusedName, writeEnvLocal, writeExample } from "../../dist/plugins/connections/files.js";
import { change, list, release } from "../../dist/plugins/connections/routes.js";

const HOST = "revbound-acme.vercel.app", TEAM = "team_acme", PROJECT = "prj_acme", TOKEN = "vercel-token-0123456789";
const SECRET = "apk_secret_$value";
const HOSTED = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_now", VERCEL_PROJECT_PRODUCTION_URL: HOST, VERCEL_PROJECT_ID: PROJECT,
  REVBOUND_VERCEL_TOKEN: TOKEN };
const VARS = [...Object.keys(HOSTED), "REVBOUND_VERCEL_TOKEN_EXPIRES", "REVBOUND_ALLOWED_HOSTS", "NODE_ENV", "REVBOUND_DEV"];
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const SESSION = jwt({ userId: "U0MEMBER01", ownerId: TEAM, aud: HOST, sub: "sso-protection" });

/**
 * Runs fn with exactly `env` of VARS set and fetch answered by a stand-in Vercel: the probe (401 anonymous, the probe
 * text with the session cookie), the project, its Production variables and deployments. `calls` records every API call.
 */
async function hosted(fn, { env = HOSTED, envs = [], anonymousProbe = 401, deployment = { readyState: "READY", readySubstate: "PROMOTED" } } = {}) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]])), fetch = globalThis.fetch, calls = [];
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    if (u.pathname === "/_revbound/probe.txt") {
      return new Response(init.headers?.cookie === `_vercel_jwt=${SESSION}` ? "revbound-probe-v1\n" : "login", { status: init.headers?.cookie ? 200 : anonymousProbe });
    }
    calls.push({ method, path: u.pathname, body, auth: init.headers?.authorization });
    if (u.pathname === `/v9/projects/${PROJECT}`) return Response.json({ accountId: TEAM, name: "revbound-acme" });
    if (u.pathname === `/v10/projects/${PROJECT}/env` && method === "GET") return Response.json({ envs });
    if (u.pathname.startsWith("/v13/deployments/")) {
      return Response.json({ projectId: PROJECT, inspectorUrl: "https://vercel.com/acme-team/revbound-acme/dpl_x", ...deployment });
    }
    if (u.pathname === "/v6/deployments") return Response.json({ deployments: [{ uid: "dpl_now", readyState: "READY" }] });
    return Response.json({ id: "dpl_next", url: "revbound-acme-next.vercel.app" });
  };
  try { return await fn(calls); } finally {
    globalThis.fetch = fetch;
    for (const k of VARS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}

const ctx = { has: () => false, manifest: { connections: [{ name: "APOLLO_API_KEY", label: "Apollo", plugins: [] }] } };
const browser = (method, { host = HOST, cookie = `_vercel_jwt=${SESSION}`, headers = {}, body } = {}) =>
  new Request(`https://${host}/api/revbound/connections${method === "POST" ? "/change" : ""}`, {
    method, body: body && JSON.stringify(body),
    headers: { host, cookie, origin: `https://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  });
const read = async (res) => ({ status: res.status, body: await res.json(), text: "" });

test("files: .env.local keeps other entries and escapes $; .env.example gets the name with its label; delete removes both", () => {
  const dir = mkdtempSync(join(tmpdir(), "revbound-connections-"));
  try {
    writeFileSync(join(dir, ".env.local"), "KEEP='x'\nAPOLLO_API_KEY='old\nstill old'\n");
    writeFileSync(join(dir, ".env.example"), "# Connections: every key this project uses.\n");
    writeEnvLocal(dir, "APOLLO_API_KEY", SECRET);
    writeExample(dir, "APOLLO_API_KEY", "Apollo");
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "KEEP='x'\nAPOLLO_API_KEY='apk_secret_\\$value'\n");
    assert.equal(statSync(join(dir, ".env.local")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, ".env.example"), "utf8"), "# Connections: every key this project uses.\n\n# Apollo\nAPOLLO_API_KEY=\n");
    writeExample(dir, "APOLLO_API_KEY", "Apollo (Production)");
    assert.match(readFileSync(join(dir, ".env.example"), "utf8"), /# Apollo \(Production\)\nAPOLLO_API_KEY=\n$/);
    writeEnvLocal(dir, "APOLLO_API_KEY", null);
    writeExample(dir, "APOLLO_API_KEY", null);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "KEEP='x'\n");
    assert.equal(readFileSync(join(dir, ".env.example"), "utf8"), "# Connections: every key this project uses.\n\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const n of ["DATABASE_URL", "PGHOST", "CRON_SECRET", "REVBOUND_VERCEL_TOKEN", "VERCEL_TOKEN", "NEON_X", "SLACK_BOT_TOKEN", "GITHUB_TOKEN", "EVE_X"]) assert.ok(refusedName(n), n);
  assert.ok(!refusedName("AI_GATEWAY_API_KEY") && refusedName("AI_GATEWAY_API_KEY", true));
  assert.ok(!refusedName("APOLLO_API_KEY", true));
});

test("console access: reads like session; writes only same-origin, locally from this computer or a Tailscale login, hosted without a bypass", () => {
  const r = (method, host, headers = {}) => new Request(`http://${host}/api/revbound/connections/change`, { method, headers: { host, ...headers } });
  const local = { REVBOUND_ALLOWED_HOSTS: "box.tail1234.ts.net" };
  assert.ok(routeAccess("console", r("POST", "127.0.0.1:3000", { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" }), undefined, local).ok);
  assert.ok(!routeAccess("console", r("POST", "127.0.0.1:3000", { origin: "https://example.com", "sec-fetch-site": "cross-site" }), undefined, local).ok);
  assert.ok(routeAccess("console", r("GET", "box.tail1234.ts.net"), undefined, local).ok, "an allowed host reads");
  assert.ok(!routeAccess("console", r("POST", "box.tail1234.ts.net", { origin: "http://box.tail1234.ts.net" }), undefined, local).ok, "but writes only with a Tailscale login");
  assert.ok(routeAccess("console", r("POST", "box.tail1234.ts.net", { origin: "http://box.tail1234.ts.net", "tailscale-user-login": "member@example.com" }), undefined, local).ok);
  assert.ok(!routeAccess("console", r("POST", "evil.test", { origin: "http://evil.test" }), undefined, local).ok);
  const env = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_now" };
  assert.ok(routeAccess("console", r("POST", HOST, { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }), undefined, env).ok);
  assert.ok(!routeAccess("console", r("POST", HOST, { origin: "https://example.com", "sec-fetch-site": "cross-site" }), undefined, env).ok);
  assert.ok(!routeAccess("console", r("POST", HOST, { origin: `https://${HOST}`, "x-vercel-protection-bypass": "s" }), undefined, env).ok);
  assert.equal(routeAccess("session", r("POST", HOST), undefined, env).status, 405, "session routes stay read-only");
});

test("hosted: a signed-in browser on the production domain saves a Production-only Sensitive key with its Note, then production redeploys", () => hosted(async (calls) => {
  const listed = await read(await list(browser("GET"), ctx));
  assert.equal(listed.body.save.mode, "hosted");
  const csrf = listed.body.save.csrf;
  assert.ok(csrf);
  const res = await change(browser("POST", { headers: { "x-revbound-csrf": csrf }, body: { action: "save", name: "APOLLO_API_KEY", label: "Apollo", value: SECRET } }), ctx);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes(SECRET), "the value is never sent back");
  assert.match(JSON.parse(text).status, /redeploying/);
  assert.equal(JSON.parse(text).id, "dpl_next", "the badge follows the new deployment");
  assert.equal(listed.body.settingsUrl, "https://vercel.com/acme-team/revbound-acme/settings/environment-variables");
  const upsert = calls.find((c) => c.method === "POST" && c.path === `/v10/projects/${PROJECT}/env`);
  assert.deepEqual(upsert.body, { key: "APOLLO_API_KEY", value: SECRET, type: "sensitive", target: ["production"], comment: "Apollo" });
  assert.equal(upsert.auth, `Bearer ${TOKEN}`);
  assert.deepEqual(calls.find((c) => c.path === "/v13/deployments").body, { name: "revbound-acme", deploymentId: "dpl_now", target: "production" });
}));

test("hosted: edit renames the Note only, delete removes the variable; shared, integration and refused names are not changed", () => hosted(async (calls) => {
  const csrf = (await read(await list(browser("GET"), ctx))).body.save.csrf, headers = { "x-revbound-csrf": csrf };
  const send = async (body) => read(await change(browser("POST", { headers, body }), ctx));
  assert.equal((await send({ action: "rename", name: "APOLLO_API_KEY", label: "Apollo (Production)" })).status, 200);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { comment: "Apollo (Production)" });
  assert.ok(!calls.some((c) => c.path === "/v13/deployments"), "a rename redeploys nothing");
  assert.equal((await send({ action: "delete", name: "APOLLO_API_KEY" })).status, 200);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === `/v9/projects/${PROJECT}/env/env_apollo`));
  assert.equal((await send({ action: "save", name: "HUNTER_API_KEY", value: "x" })).status, 409, "shared with Preview");
  assert.equal((await send({ action: "save", name: "VERCEL_TOKEN", value: "x" })).status, 400);
  assert.equal((await send({ action: "save", name: "AI_GATEWAY_API_KEY", value: "x" })).status, 400);
  const rows = (await read(await list(browser("GET"), ctx))).body.connections;
  assert.equal(rows.find((c) => c.name === "HUNTER_API_KEY").state, "readonly");
  assert.deepEqual(rows.find((c) => c.name === "APOLLO_API_KEY").actions, ["save", "rename", "delete"]);
  assert.equal(rows.find((c) => c.name === "APOLLO_API_KEY").label, "Apollo (Note)");
}, { envs: [
  { id: "env_apollo", key: "APOLLO_API_KEY", target: ["production"], type: "sensitive", comment: "Apollo (Note)" },
  { id: "env_hunter", key: "HUNTER_API_KEY", target: ["production", "preview"], type: "encrypted" },
] }));

test("hosted: refused without the CSRF token, off the production domain, without a login session or with Vercel Authentication off", async () => {
  await hosted(async (calls) => {
    const body = { action: "save", name: "APOLLO_API_KEY", value: SECRET };
    assert.equal((await change(browser("POST", { body }), ctx)).status, 403, "no CSRF token");
    const preview = "revbound-acme-git-x.vercel.app";
    assert.equal((await read(await list(browser("GET", { host: preview }), ctx))).body.save.mode, "off");
    assert.equal((await change(browser("POST", { host: preview, body }), ctx)).status, 403);
    assert.equal((await read(await list(browser("GET", { cookie: "" }), ctx))).body.save.mode, "off");
    const other = jwt({ userId: "U0MEMBER01", ownerId: "team_other", aud: HOST, sub: "sso-protection" });
    assert.equal((await read(await list(browser("GET", { cookie: `_vercel_jwt=${other}` }), ctx))).body.save.mode, "off");
    assert.ok(!calls.some((c) => c.method !== "GET"), "nothing was written");
  });
  await hosted(async () => assert.equal((await read(await list(browser("GET"), ctx))).body.save.mode, "off"), { anonymousProbe: 200 });
  await hosted(async () => {
    const listed = (await read(await list(browser("GET"), ctx))).body;
    assert.equal(listed.save.mode, "link", "no token: changes happen in Vercel");
    assert.deepEqual(listed.connections[0].actions, []);
  }, { env: { ...HOSTED, REVBOUND_VERCEL_TOKEN: "" } });
  await hosted(async () => assert.match((await read(await list(browser("GET"), ctx))).body.tokenWarning, /expires in 3 days/),
    { env: { ...HOSTED, REVBOUND_VERCEL_TOKEN_EXPIRES: new Date(Date.now() + 2.5 * 86_400_000).toISOString() } });
});

test("hosted: the badge's release route says live once the redeploy serves, failed with its inspector link, and only for this project", async () => {
  const state = async () => (await read(await release(new Request(`https://${HOST}/api/revbound/connections/release?id=dpl_next`)))).body;
  await hosted(async () => assert.deepEqual(await state(), { release: { state: "live" } }));
  await hosted(async () => assert.deepEqual(await state(), { release: { state: "updating" } }), { deployment: { readyState: "READY", readySubstate: "STAGED" } });
  await hosted(async () => assert.deepEqual(await state(), { release: { state: "failed", details: "https://vercel.com/acme-team/revbound-acme/dpl_x" } }),
    { deployment: { readyState: "ERROR" } });
  await hosted(async () => assert.match((await state()).error, /not this project/), { deployment: { projectId: "prj_other" } });
  await hosted(async () => assert.equal((await release(new Request(`https://${HOST}/api/revbound/connections/release?id=../x`))).status, 400));
});
