/** The agent plugin: who opens the chat, the yes, GitHub's limits, the model, the files sync writes (against the build). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { project, write } from "./project.mjs";

const dist = (file) => import(new URL(`../../dist/plugins/agent/${file}.js`, import.meta.url).href);
const { consoleCaller } = await dist("access");
const { githubCommand, requesterOnly, runApproval, words } = await dist("approval");
const { withChannels } = await dist("cli");
const { chooseChatModel } = await dist("model");
const { parseReply, systemPrompt, toContent, transcript } = await dist("claude");
const { agent, agentFiles } = await dist("index");
const { guard, hidden, locked, projectFs, seedFiles } = await dist("eve/sandbox");
const { instructions } = await dist("eve/instructions");
const { fromCompany } = await dist("eve/teams");
const { skillProblems } = await dist("checks");

const HOSTED = { VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_test" };
const req = (url, { method = "GET", headers = {} } = {}) => new Request(url, { method, headers: { host: new URL(url).host, ...headers } });
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

test("console chat, locally: this computer and Tailscale logins on an allowed host; never another host or site", () => {
  const local = consoleCaller(req("http://127.0.0.1:3000/eve/v1/session", { method: "POST", headers: { origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" } }), {});
  assert.deepEqual(local, { ok: true, principalId: "local", attributes: { via: "local" } });
  // Behind Next's rewrite, Host is eve's dev server and the browser's host is in X-Forwarded-Host.
  const proxied = consoleCaller(req("http://127.0.0.1:41000/eve/v1/session", { method: "POST", headers: { "x-forwarded-host": "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }), {});
  assert.equal(proxied.ok, true);
  const env = { REVBOUND_ALLOWED_HOSTS: "box.tail1234.ts.net" };
  const tailnet = consoleCaller(req("http://127.0.0.1:41000/eve/v1/session", { method: "POST", headers: { "x-forwarded-host": "box.tail1234.ts.net", origin: "https://box.tail1234.ts.net", "tailscale-user-login": "Ann@example.com" } }), env);
  assert.deepEqual(tailnet, { ok: true, principalId: "tailnet:ann@example.com", attributes: { via: "tailnet" } });
  const noLogin = consoleCaller(req("http://127.0.0.1:41000/eve/v1/session", { headers: { "x-forwarded-host": "box.tail1234.ts.net" } }), env);
  assert.equal(noLogin.ok, false, "an allowed host without a Tailscale login reads the console but cannot chat");
  const funnel = consoleCaller(req("http://127.0.0.1:41000/eve/v1/session", { headers: { "x-forwarded-host": "box.tail1234.ts.net", "tailscale-user-login": "a@example.com", "tailscale-funnel-request": "1" } }), env);
  assert.equal(funnel.ok, false, "never through Funnel");
  assert.equal(consoleCaller(req("http://evil.example/eve/v1/session"), {}).ok, false, "a foreign host");
  const crossSite = consoleCaller(req("http://127.0.0.1:3000/eve/v1/session", { method: "POST", headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } }), {});
  assert.equal(crossSite.ok, false, "a write from another site");
});

test("console chat, hosted: Vercel's login only, never a bypass credential, never another site", () => {
  const host = "https://revbound-acme.vercel.app/eve/v1/session";
  const login = jwt({ sub: "sso-protection", user_id: "user_123" });
  const ok = consoleCaller(req(host, { method: "POST", headers: { cookie: `_vercel_jwt=${login}`, origin: "https://revbound-acme.vercel.app", "sec-fetch-site": "same-origin" } }), HOSTED);
  assert.deepEqual(ok, { ok: true, principalId: "user_123", attributes: { via: "vercel" } });
  for (const headers of [
    { "x-vercel-protection-bypass": "secret" },
    { cookie: `_vercel_jwt=${jwt({ sub: "protection-bypass-automation", bypass: "x" })}` },
    { "x-vercel-set-bypass-cookie": "true" },
  ]) assert.equal(consoleCaller(req(host, { headers }), HOSTED).ok, false, JSON.stringify(headers));
  assert.equal(consoleCaller(req(`${host}?x-vercel-protection-bypass=secret`), HOSTED).ok, false, "bypass in the query");
  assert.equal(consoleCaller(req(host, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), HOSTED).ok, false);
  assert.equal(consoleCaller(req(host, { headers: { authorization: "Bearer vercel-oidc-token" } }), HOSTED).principalId, "vercel-login", "an OIDC token adds nothing");
});

test("the yes: deployed previews run at once; real runs, and every run on a laptop, wait; only the requester settles them", async () => {
  assert.equal(runApproval({ toolInput: { preview: true } }, true), "not-applicable");
  assert.equal(runApproval({ toolInput: { preview: false } }, true), "user-approval");
  assert.equal(runApproval({}, true), "user-approval");
  assert.equal(runApproval({ toolInput: { preview: true } }, false), "user-approval", "a laptop preview runs code the agent may have edited");
  const ann = { authenticator: "revbound-console", principalType: "user", principalId: "tailnet:ann@example.com" };
  const bob = { ...ann, principalId: "tailnet:bob@example.com" };
  assert.deepEqual(await requesterOnly({ request: { principal: ann }, response: { decision: "approve", principal: ann } }), { status: "allowed" });
  assert.equal((await requesterOnly({ request: { principal: ann }, response: { decision: "approve", principal: bob } })).status, "rejected");
  assert.equal((await requesterOnly({ request: { principal: ann }, response: { decision: "approve", principal: { ...ann, authenticator: "slack-webhook" } } })).status, "rejected", "same id, another channel");
});

test("git__gh: pull-request branches only; nothing reaches main or changes settings", () => {
  const ok = (c) => assert.equal(githubCommand(c), "not-applicable", c);
  const no = (c) => assert.equal(githubCommand(c).type, "denied", c);
  ok("git fetch origin 0123abc");
  ok("git push origin revbound/add-icp");
  ok("git push origin HEAD:refs/heads/revbound/add-icp");
  ok('gh-signed-commit --repo acme/revbound-acme --branch revbound/add-icp -m "Add ICP"');
  ok('gh pr create --draft --title "Add ICP" --body-file /tmp/b.md --base main --head revbound/add-icp');
  ok("gh pr view 12");
  ok("gh api repos/acme/revbound-acme/pulls");
  no("git push origin main");
  no("git push origin HEAD:main");
  no("git push --force origin revbound/x");
  no("git push origin");
  no("git push origin revbound/x main");
  no('gh-signed-commit --repo acme/revbound-acme --branch main -m "x"');
  no('gh-signed-commit --branch revbound/x --branch main -m "x"');
  no('gh pr create --head revbound/x -H main --title x --body x');
  no("gh api repos/acme/revbound-acme -X GET --method PATCH");
  no('gh pr create --head main --title x --body x');
  no("gh pr merge 12 --squash");
  no("gh repo delete acme/revbound-acme --yes");
  no("gh api -X DELETE repos/acme/revbound-acme");
  no("gh api repos/acme/revbound-acme/pulls -f title=x");
  no("gh api repos/acme/revbound-acme/pulls/1/merge -XPUT");
  no("gh api repos/acme/revbound-acme/pulls/1/merge -X=PUT");
  no("gh api repos/acme/revbound-acme/pulls/1/merge --method=put");
  no("gh api repos/acme/revbound-acme/issues -ftitle=x");
  no("gh pr create -Hmain --title x --body x");
  no("gh secret set X");
  no("git reset --hard");
  assert.deepEqual(words(`gh pr create --title "Add an ICP" --body 'x y'`), ["gh", "pr", "create", "--title", "Add an ICP", "--body", "x y"]);
});

test("revbound agent add/remove edit the agent() line, or say they cannot", () => {
  const src = `plugins: [\n    console(),\n    agent(),\n  ],`;
  assert.match(withChannels(src, ["console", "slack"]), /agent\(\{ channels: \["console", "slack"\] \}\)/);
  assert.match(withChannels(`agent({ model: "anthropic/claude-opus-5.5" })`, ["console", "slack"]), /^agent\(\{ channels: \["console", "slack"\], model: "anthropic\/claude-opus-5.5" \}\)$/);
  assert.equal(withChannels(`agent({ channels: ["console", "slack"] })`, ["console"]), `agent({ channels: ["console"] })`);
  assert.equal(withChannels(`const plugins = [agentPlugin];`, ["console"]), undefined);
});

test("the chat's model: AI Gateway when deployed or keyed, an API key, else the local codex or claude", () => {
  assert.deepEqual(chooseChatModel(undefined, { VERCEL: "1", REVBOUND_AGENT_BACKEND: "claude" }), { kind: "gateway", model: "anthropic/claude-haiku-5.5" });
  assert.deepEqual(chooseChatModel(undefined, { VERCEL: "1", REVBOUND_AGENT_BACKEND: "codex" }), { kind: "gateway", model: "openai/gpt-6-sol" });
  assert.deepEqual(chooseChatModel("anthropic/claude-opus-5.5", { AI_GATEWAY_API_KEY: "k" }), { kind: "gateway", model: "anthropic/claude-opus-5.5" });
  assert.deepEqual(chooseChatModel(undefined, { ANTHROPIC_API_KEY: "k" }), { kind: "anthropic", id: "claude-haiku-5-5" });
  assert.deepEqual(chooseChatModel(undefined, { OPENAI_API_KEY: "k", REVBOUND_AGENT_BACKEND: "codex" }), { kind: "openai", id: "gpt-6-sol" });
  assert.deepEqual(chooseChatModel(undefined, { REVBOUND_AGENT_BACKEND: "codex" }), { kind: "codex" });
  assert.deepEqual(chooseChatModel(undefined, { REVBOUND_AGENT_BACKEND: "claude" }), { kind: "claude", id: "claude-haiku-5-5" });
  assert.deepEqual(chooseChatModel(undefined, { REVBOUND_CHAT_MODEL: "anthropic/claude-opus-5.5" }), { kind: "claude", id: "claude-opus-5-5" });
});

test("the claude model: eve's tools as a structured reply, results paired by id, bad calls handed back as text", () => {
  const tools = [{ type: "function", name: "bash", description: "Run a command.", inputSchema: { type: "object", properties: { command: { type: "string" } } } }];
  const prompt = [
    { role: "system", content: "You are the agent." },
    { role: "user", content: [{ type: "text", text: "List the workflows." }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls workflows" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "json", value: { stdout: "index.ts" } } }] },
  ];
  assert.match(systemPrompt(prompt, tools, { type: "auto" }), /^You are the agent\.[\s\S]*### bash\nRun a command\./);
  assert.match(systemPrompt(prompt, [], undefined), /leave `tool_calls` empty/);
  const text = transcript(prompt);
  assert.match(text, /<user>\nList the workflows\.\n<\/user>/);
  assert.match(text, /<tool_call id="c1" name="bash">\{"command":"ls workflows"\}<\/tool_call>/);
  assert.match(text, /<tool_result id="c1" name="bash">\{"stdout":"index.ts"\}<\/tool_result>/);
  const reply = parseReply(JSON.stringify({ is_error: false, structured_output: { text: "", tool_calls: [{ name: "bash", arguments: '{"command":"pwd"}' }, { name: "rm_rf", arguments: "{}" }, { name: "bash", arguments: "{oops" }] }, usage: { input_tokens: 3, output_tokens: 2 } }));
  let n = 0;
  const { content, calls } = toContent(reply, tools, () => `id${(n += 1)}`);
  assert.equal(calls, 1);
  assert.deepEqual(content[1], { type: "tool-call", toolCallId: "id1", toolName: "bash", input: '{"command":"pwd"}' });
  assert.match(content[0].text, /rm_rf with input that is not a tool here[\s\S]*bash with input that is not JSON/);
  assert.throws(() => parseReply(JSON.stringify({ is_error: true, result: "Not logged in" })), /Not logged in/);
});

test("the sandbox hides keys and local state, and keeps Revbound's own docs readable", async () => {
  for (const p of ["/.env.local", "/.env", "/.env.production.local", "/.vercel/project.json", "/.revbound/db.lock", "/.eve/traces/x", "/node_modules/pg/index.js", "/.git/config"]) assert.equal(hidden(p), true, p);
  for (const p of ["/.env.example", "/AGENTS.md", "/context/company.md", "/node_modules", "/node_modules/revbound/docs/plugins.md"]) assert.equal(hidden(p), false, p);
  // Paths as the shell's mount passes them: the project folder's own.
  const files = { "/.env.local": "KEY=1", "/AGENTS.md": "# Acme", "/.revbound/db.lock": "{}" };
  const fake = {
    async readFile(p) { if (!(p in files)) throw new Error("missing"); return files[p]; },
    async readdir() { return [".env.local", ".revbound", "AGENTS.md"]; },
    async exists(p) { return p in files; },
    getAllPaths() { return Object.keys(files); },
    resolvePath(base, p) { return path.posix.resolve(base, p); },
    async stat(p) { return { isDirectory: p === "/" || p === "/.revbound" }; },
    async cp() { return "copied"; },
    async writeFile() { return "written"; },
    async mv() { return "moved"; },
    async symlink() { return "linked"; },
  };
  const fsg = guard(fake);
  assert.deepEqual(await fsg.readdir("/"), ["AGENTS.md"]);
  assert.equal(await fsg.exists("/.env.local"), false);
  await assert.rejects(() => fsg.readFile("/.env.local"), /ENOENT/);
  await assert.rejects(() => fsg.readFile("/.revbound/db.lock"), /ENOENT/);
  assert.equal(await fsg.readFile("/AGENTS.md"), "# Acme");
  assert.deepEqual(fsg.getAllPaths(), ["/AGENTS.md"]);
  await assert.rejects(() => fsg.symlink(".env.local", "/x"), /EPERM/, "no link to a hidden file");
  await assert.rejects(() => fsg.cp("/", "/tmp/copy", { recursive: true }), /EPERM/, "no directory copy that would carry hidden files");
  assert.equal(await fsg.cp("/AGENTS.md", "/tmp/a.md"), "copied");
  for (const p of ["/revbound.config.ts", "/package.json", "/plugins/notes/index.ts", "/app/layout.tsx", "/agent/agent.ts", "/.agents/skills/x/run.ts", "/.env.example"]) assert.equal(locked(p), true, p);
  for (const p of ["/workflows/enrich.ts", "/workflows/index.ts", "/context/icp.md", "/.agents/skills/x/SKILL.md", "/AGENTS.md"]) assert.equal(locked(p), false, p);
  await assert.rejects(() => fsg.writeFile("/revbound.config.ts", "x"), /EROFS/, "sync's watcher would run it");
  await assert.rejects(() => fsg.mv("/AGENTS.md", "/plugins/x/index.ts"), /EROFS/);
  await assert.rejects(() => fsg.symlink("/workflows/x.ts", "/w.ts"), /EPERM/, "no links at all");
});

test("the laptop shell follows no link already in the project, so none leads past the hidden or read-only files", async () => {
  const { ReadWriteFs } = await import("just-bash");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revbound-links-"));
  fs.mkdirSync(path.join(dir, "context"));
  fs.writeFileSync(path.join(dir, ".env.local"), "KEY=1");
  fs.writeFileSync(path.join(dir, "revbound.config.ts"), "cfg");
  fs.symlinkSync("../.env.local", path.join(dir, "context/k.md"));
  fs.symlinkSync("../revbound.config.ts", path.join(dir, "context/config.md"));
  fs.symlinkSync("..", path.join(dir, "context/up"));
  const p = projectFs(ReadWriteFs, dir);
  await assert.rejects(() => p.readFile("/context/k.md"), /EACCES/);
  await assert.rejects(() => p.readFile("/context/up/.env.local"));
  await assert.rejects(() => p.writeFile("/context/config.md", "x"), /EACCES/);
  await assert.rejects(() => p.writeFile("/context/up/revbound.config.ts", "x"));
  assert.equal(fs.readFileSync(path.join(dir, "revbound.config.ts"), "utf8"), "cfg");
  // A folder write reaches all it holds: refused when that includes a hidden or read-only file.
  fs.mkdirSync(path.join(dir, "workflows"));
  fs.writeFileSync(path.join(dir, "workflows/a.ts"), "a");
  await assert.rejects(() => p.rm("/", { recursive: true, force: true }), /EROFS/);
  fs.mkdirSync(path.join(dir, "notes/.git"), { recursive: true });
  await assert.rejects(() => p.rm("/notes", { recursive: true }), /EROFS/);
  await p.rm("/workflows", { recursive: true });
  assert.equal(fs.existsSync(path.join(dir, "workflows")), false, "a folder of plain files can go");
  assert.equal(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), "KEY=1");
  fs.rmSync(dir, { recursive: true });
});

test("the deployed sandbox's seed: no keys or build output, links kept as links", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revbound-seed-"));
  for (const [f, body] of [["AGENTS.md", "# Acme"], [".env.local", "KEY=1"], [".agents/skills/x/SKILL.md", "---\ndescription: x\n---"], [".next/a.js", ""], ["node_modules/pg/index.js", ""]]) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  fs.mkdirSync(path.join(dir, "agent"));
  fs.symlinkSync("../.agents/skills", path.join(dir, "agent/skills"));
  const { files, links } = seedFiles(dir);
  assert.deepEqual(files.map((f) => f.path).sort(), ["/workspace/.agents/skills/x/SKILL.md", "/workspace/AGENTS.md"]);
  assert.deepEqual(links, [{ path: "agent/skills", target: "../.agents/skills" }], "not a copy of the skills, which check would call stale");
  fs.rmSync(dir, { recursive: true });
});

test("the deployed instructions: a pull request of only the agent's edits; without a linked repository, the one step", () => {
  const text = (env) => JSON.stringify(instructions(env));
  const linked = text({ VERCEL: "1", VERCEL_GIT_REPO_OWNER: "acme", VERCEL_GIT_REPO_SLUG: "gtm", VERCEL_GIT_COMMIT_REF: "main", VERCEL_GIT_COMMIT_SHA: "abc123" });
  assert.match(linked, /acme\/gtm/);
  assert.match(linked, /git diff HEAD --binary/);
  assert.match(linked, /fetch `abc123`/);
  assert.match(linked, /vercel connect create github --name revbound/);
  const unlinked = text({ VERCEL: "1" });
  assert.match(unlinked, /vercel git connect/);
  assert.match(unlinked, /Never ask them for the repository/);
  assert.doesNotMatch(unlinked, /git__gh/);
  assert.match(text({}), /Never commit, push or open pull requests from here/);
  assert.match(text({ VERCEL: "1", REVBOUND_DEV: "1" }), /Never commit/, "a pulled VERCEL=1 under revbound dev is still the laptop");
});

test("Teams: only people of the company's tenant", () => {
  const activity = (tenantId, from = { id: "29:1", aadObjectId: "aad-1" }) => ({ tenantId, conversation: { id: "c" }, from, recipient: { id: "28:bot" } });
  assert.equal(fromCompany(activity("tenant-a"), "tenant-a"), true);
  assert.equal(fromCompany(activity("tenant-b"), "tenant-a"), false, "another organization");
  assert.equal(fromCompany(activity("tenant-a"), undefined), false, "no tenant set refuses everyone");
  assert.equal(fromCompany(activity("tenant-a", { id: "28:other", role: "bot", aadObjectId: "x" }), "tenant-a"), false, "a bot");
});

test("agent(): the eve folder for its channels, the Chat page with the console channel, keys for chat apps", () => {
  const files = agentFiles(["console"]);
  assert.match(files["agent/channels/eve.ts"], /revbound\/agent\/eve\/console/);
  assert.deepEqual(files["agent/skills"], { link: "../.agents/skills" });
  assert.equal(files["agent/channels/slack.ts"], undefined);
  assert.match(agentFiles([])["agent/channels/eve.ts"], /eve\/closed/, "without the console channel, nobody opens the session API");
  const slack = agent({ channels: ["console", "slack"] });
  assert.match(slack.files["agent/channels/slack.ts"], /eve\/slack/);
  assert.deepEqual(slack.connections.map((c) => c.name), ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]);
  assert.equal(agent({ channels: ["slack"] }).views.length, 0);
  assert.throws(() => agent({ channels: ["fax"] }), /unknown channel/);
});

test("sync writes a plugin's files and link, rewrites changed ones, removes dropped ones; check reports them stale", async () => {
  const { sync, plan, stale } = await import("../../dist/core/sync.js");
  const imports = `import { agent } from "revbound/agent";`;
  const { config } = await import("./project.mjs");
  const plugins = (extra) => ["database()", "ledger()", 'workflows({ registry: "./workflows", webhooks: "./webhooks" })', "ai()", "context()", "connections()", "console()", extra];
  const dir = project({ "revbound.config.ts": config({ imports, plugins: plugins('agent({ channels: ["console", "slack"] })') }) });
  await sync(dir, true);
  assert.equal(fs.readlinkSync(path.join(dir, "agent/skills")), "../.agents/skills");
  assert.match(fs.readFileSync(path.join(dir, "agent/channels/slack.ts"), "utf8"), /revbound\/agent\/eve\/slack/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "_revbound/files.json"), "utf8")).includes("agent/channels/slack.ts"), true);
  fs.writeFileSync(path.join(dir, "agent/tools/start_run.ts"), "// edited\n");
  fs.rmSync(path.join(dir, "agent/skills"));
  assert.deepEqual(stale(dir, await plan(dir)).sort(), ["agent/skills", "agent/tools/start_run.ts"]);
  write(dir, { "revbound.config.ts": config({ imports, plugins: plugins("agent()") }) });
  await sync(dir, true);
  assert.equal(fs.existsSync(path.join(dir, "agent/channels/slack.ts")), false, "a dropped channel's file goes");
  assert.match(fs.readFileSync(path.join(dir, "agent/tools/start_run.ts"), "utf8"), /startRun as default/);
  assert.deepEqual(stale(dir, await plan(dir)), []);
  write(dir, { "revbound.config.ts": config({ imports, plugins: plugins("database()").slice(0, 7) }) });
  await sync(dir, true);
  assert.equal(fs.existsSync(path.join(dir, "agent")) && fs.readdirSync(path.join(dir, "agent"), { recursive: true }).some((f) => /\.ts$/.test(f)), false, "removing the plugin removes its files");
  assert.equal(fs.existsSync(path.join(dir, "agent/skills")), false);
});

test("the agent's check: .agents/skills holds only skill folders with a description", () => {
  const dir = project({ ".agents/skills/good/SKILL.md": "---\nname: good\ndescription: Use when good.\n---\nBody", ".agents/skills/bare/SKILL.md": "No front matter", ".agents/skills/README.md": "x" });
  fs.mkdirSync(path.join(dir, ".agents/skills/empty"));
  const problems = skillProblems(dir).map((p) => p.message);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.ok(problems.some((m) => m.includes("README.md is not a skill folder")));
  assert.ok(problems.some((m) => m.includes("empty has no SKILL.md")));
  assert.ok(problems.some((m) => m.includes("bare/SKILL.md has no description")));
});
