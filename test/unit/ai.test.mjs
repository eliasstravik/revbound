/** agent()'s pure parts, against the build (`npm run build` first): backend choice, model ids, schemas, CLI arguments and replies, skills. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeArgs, codexArgs, excerpt, parseClaude, parseCodex } from "../../dist/plugins/ai/cli.js";
import { chooseBackend, cliModel, providerModel, sanitizeSchema } from "../../dist/plugins/ai/models.js";
import { codeFindings } from "../../dist/core/check.js";
import { mask } from "../../dist/core/mask.js";
import { parseSkill } from "../../dist/kit/skill.js";

const VARS = ["VERCEL_ENV", "VERCEL_DEPLOYMENT_ID", "NODE_ENV", "REVBOUND_DEV", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY", "REVBOUND_MODEL", "REVBOUND_AGENT_BACKEND"];
/** Runs fn with exactly these of VARS set. */
function withEnv(env, fn) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally { for (const k of VARS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
}
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const route = (env, o = {}) => withEnv(env, () => chooseBackend({ name: "stage", ...o }));

test("backend: hosted and laptop Gateway, then API keys, then the CLI", () => {
  assert.deepEqual(route({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_1" }), { kind: "gateway", model: "openai/gpt-6-luna" });
  assert.deepEqual(route({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_1", REVBOUND_AGENT_BACKEND: "claude" }), { kind: "gateway", model: "anthropic/claude-haiku-5.5" });
  assert.equal(route({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_1", NODE_ENV: "development" }).kind, "cli", "next dev is never hosted");
  assert.deepEqual(route({ AI_GATEWAY_API_KEY: "k", REVBOUND_MODEL: "anthropic/claude-sonnet-5.5" }), { kind: "gateway", model: "anthropic/claude-sonnet-5.5" });
  assert.deepEqual(route({ AI_GATEWAY_API_KEY: "k", REVBOUND_MODEL: "x/y" }, { model: "openai/gpt-6" }), { kind: "gateway", model: "openai/gpt-6" }, "a stage's model wins");
  assert.equal(route({ VERCEL_OIDC_TOKEN: jwt({ exp: Date.now() / 1000 + 600 }) }).kind, "gateway");
  assert.throws(() => route({ VERCEL_OIDC_TOKEN: jwt({ exp: 1 }) }), /expired.*vercel env pull/);
  assert.deepEqual(route({ ANTHROPIC_API_KEY: "k" }), { kind: "anthropic", id: "claude-haiku-5-5" }, "the default family has no key: the other one");
  assert.deepEqual(route({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }), { kind: "openai", id: "gpt-6-luna" });
  assert.deepEqual(route({ OPENAI_API_KEY: "k", REVBOUND_MODEL: "openai/gpt-6" }), { kind: "openai", id: "gpt-6" });
  assert.throws(() => route({ OPENAI_API_KEY: "k" }, { model: "anthropic/claude-sonnet-5.5" }), /needs ANTHROPIC_API_KEY/);
  assert.deepEqual(route({}), { kind: "cli", cli: undefined });
  assert.deepEqual(route({ REVBOUND_AGENT_BACKEND: " Codex " }), { kind: "cli", cli: "codex" });
  assert.deepEqual(route({ REVBOUND_AGENT_BACKEND: "gateway" }), { kind: "cli", cli: undefined });
  assert.throws(() => route({}, { custom: true }), /custom tools need AI Gateway or an API key/);
});

test("providerModel and cliModel: a CLI gets a model only of its own family", () => {
  assert.deepEqual(providerModel("anthropic/claude-haiku-5.5"), { family: "anthropic", id: "claude-haiku-5-5" });
  assert.deepEqual(providerModel("anthropic/claude-sonnet-5.5"), { family: "anthropic", id: "claude-sonnet-5-5" });
  assert.deepEqual(providerModel("openai/gpt-6.1"), { family: "openai", id: "gpt-6.1" });
  assert.deepEqual(providerModel("claude-opus-5"), { family: "anthropic", id: "claude-opus-5" });
  assert.throws(() => providerModel("google/gemini-4"), /only through AI Gateway/);
  withEnv({}, () => {
    assert.equal(cliModel("claude", "anthropic/claude-sonnet-5.5"), "claude-sonnet-5-5");
    assert.equal(cliModel("codex", "anthropic/claude-sonnet-5.5"), undefined);
    assert.equal(cliModel("codex", "openai/gpt-6-luna"), "gpt-6-luna");
    assert.equal(cliModel("claude", "google/gemini-4"), undefined);
    assert.equal(cliModel("claude"), undefined, "no model named: the CLI's own default");
  });
  withEnv({ REVBOUND_MODEL: "openai/gpt-6" }, () => assert.equal(cliModel("codex"), "gpt-6"));
});

test("sanitizeSchema drops $schema and string formats, not properties named format", () => {
  const schema = { $schema: "x", type: "object", properties: { format: { type: "string", format: "email" }, url: { type: ["string", "null"], format: "uri" },
    list: { type: "array", items: { type: "string", format: "date" } } }, required: ["format"] };
  assert.deepEqual(sanitizeSchema(schema), { type: "object", properties: { format: { type: "string" }, url: { type: ["string", "null"] },
    list: { type: "array", items: { type: "string" } } }, required: ["format"] });
});

const base = { instructions: "i", prompt: "p", web: false, timeoutMs: 1000 };

test("claude arguments: tools, model of its family, effort, budget, MCP allow lists", () => withEnv({}, () => {
  assert.deepEqual(claudeArgs(base), ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", ""]);
  const args = claudeArgs({ ...base, web: true, model: "anthropic/claude-sonnet-5.5", schema: { type: "object" }, reasoning: "none", maxUsd: 0.5,
    mcp: { crm: { url: "https://mcp.example.com", allow: ["find"] }, docs: { url: "https://docs.example.com" } } }, "/tmp/mcp.json");
  assert.deepEqual(args.slice(6), ["WebSearch,WebFetch", "--model", "claude-sonnet-5-5", "--json-schema", '{"type":"object"}', "--effort", "low",
    "--max-budget-usd", "0.5", "--mcp-config", "/tmp/mcp.json", "--allowedTools", "WebSearch", "WebFetch", "mcp__crm__find", "mcp__docs"]);
  assert.ok(!claudeArgs({ ...base, model: "openai/gpt-6" }).includes("--model"));
  assert.equal(claudeArgs({ ...base, reasoning: "max" }).at(-1), "max");
}));

test("codex arguments: no 'none' or 'minimal' effort, model of its family, schema file, MCP approval", () => withEnv({}, () => {
  const { args, env } = codexArgs({ ...base, web: true, model: "openai/gpt-6-luna", reasoning: "none", mcp: { crm: { url: "https://mcp.example.com", allow: ["find"] } } }, "/t/last.txt", "/t/schema.json");
  assert.deepEqual(args, ["exec", "-", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-o", "/t/last.txt", "-m", "gpt-6-luna",
    "--output-schema", "/t/schema.json", "-c", 'model_reasoning_effort="low"', "-c", 'web_search="live"', "-c", 'mcp_servers.crm.url="https://mcp.example.com"',
    "-c", 'mcp_servers.crm.default_tools_approval_mode="approve"', "-c", 'mcp_servers.crm.enabled_tools=["find"]']);
  assert.deepEqual(env, {});
  assert.ok(codexArgs({ ...base, reasoning: "minimal" }, "l").args.includes('model_reasoning_effort="low"'));
  assert.ok(!codexArgs({ ...base, model: "anthropic/claude-sonnet-5.5" }, "l").args.includes("-m"));
}));

test("claude replies: structured output, JSON in the text, and clear errors", () => {
  const ok = parseClaude(JSON.stringify({ structured_output: { a: 1 }, total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 3, cache_read_input_tokens: 4, output_tokens: 5 } }), { schema: {} });
  assert.deepEqual(ok, { value: { a: 1 }, costUsd: 0.01, modelCalls: 2, usage: { inputTokens: 7, outputTokens: 5 } });
  assert.deepEqual(parseClaude(JSON.stringify({ result: '```json\n{"a":2}\n```' }), { schema: {} }).value, { a: 2 });
  assert.equal(parseClaude(JSON.stringify({ result: "hello" }), {}).value, "hello");
  assert.throws(() => parseClaude(JSON.stringify({ result: "Sorry, I can't. Bearer abc.def.ghi" }), { schema: {} }),
    (e) => /claude returned no structured output.*began: Sorry, I can't\. Bearer \[redacted\]/.test(e.message));
  assert.throws(() => parseClaude("Error: not logged in", {}), /claude returned no JSON reply; it began: Error: not logged in/);
  assert.throws(() => parseClaude(JSON.stringify({ is_error: true, subtype: "error_max_budget_usd" }), { maxUsd: 0.2 }), /claude reached maxUsd \(\$0\.2\)/);
  assert.throws(() => parseClaude(JSON.stringify({ is_error: true, result: "rate limited" }), {}), /claude reported an error: rate limited/);
});

test("codex replies: the final message, and clear errors when it is missing or not JSON", () => {
  const events = ['{"type":"turn.started"}', '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'].join("\n");
  assert.deepEqual(parseCodex(events, '{"a":1}\n', { schema: {} }), { value: { a: 1 }, costUsd: 0, modelCalls: 1, usage: { inputTokens: 10, outputTokens: 2 } });
  assert.equal(parseCodex(events, " hi \n", {}).value, "hi");
  const failed = '{"type":"turn.failed","error":{"message":"model not supported"}}';
  assert.throws(() => parseCodex(failed, null, {}), /codex wrote no final message; it reported: model not supported/);
  assert.throws(() => parseCodex(events, "Here you go: {a: 1}", { schema: {} }), /codex's final message is not JSON for the schema; it began: Here you go/);
});

test("excerpt masks keys and tokens and stays short", () => {
  const s = excerpt(`key sk-ant-${"a".repeat(30)} and ${"Z".repeat(50)} and secret-value-123 ${"x ".repeat(400)}`, ["secret-value-123"]);
  assert.ok(!/sk-ant|ZZZZ|secret-value/.test(s), s);
  assert.ok(s.length <= 301);
});

test("revbound check flags AI SDK imports and model ids in workflows/, not agent() or a stage's own model", () => {
  const src = `import { agent, tool } from "#revbound/ai";\nimport type { ModelMessage } from "ai";\nimport { generateObject } from "ai";
import { gateway } from "@ai-sdk/gateway";\nconst MODEL = "openai/gpt-6";\nawait agent({ name: "a", model: "anthropic/claude-sonnet-5.5" });\nfetch("https://api.openai.com/v1");`;
  assert.deepEqual(codeFindings([["workflows/x.ts", src]], []).map((f) => f.message),
    ['workflows/x.ts:3 imports "ai".', 'workflows/x.ts:4 imports "@ai-sdk/gateway".', 'workflows/x.ts names the model "openai/gpt-6".']);
});

test("revbound check ignores AI SDK imports and model ids in comments and strings, and still flags real ones", () => {
  const flagged = (src) => codeFindings([["workflows/x.ts", src]], []).map((f) => f.message.replace(/:\d+ /, " "));
  assert.deepEqual(flagged('// Previous implementation: import { generateText } from "ai";\nexport const x = 1;'), [], "line comment");
  assert.deepEqual(flagged('/*\nimport { generateText } from "ai";\nconst m = require("@ai-sdk/openai");\n*/\nexport const x = 1;'), [], "block comment");
  assert.deepEqual(flagged('/** Was: `await import("ai")` with model: "openai/gpt-6" */\nexport const x = 1;'), [], "doc comment");
  assert.deepEqual(flagged(`const doc = 'import { generateText } from "ai"';\nconst how = "use require('ai')";`), [], "import inside a string");
  assert.deepEqual(flagged('const prompt = `Never write:\nimport { generateText } from "ai";\n${name}`;'), [], "import inside a template literal");
  assert.deepEqual(flagged('const q = s.replace(/"/g, "").split("//");\nimport { generateText } from "ai";'), ['workflows/x.ts imports "ai".'], "a quote in a regex and // in a string hide nothing");
  assert.deepEqual(flagged('// import { old } from "ai";\nimport { generateText } from "ai"; // the real one'), ['workflows/x.ts imports "ai".'], "a real import still fails");
  assert.deepEqual(flagged('const t = `${await import("@ai-sdk/anthropic")}`;'), ['workflows/x.ts imports "@ai-sdk/anthropic".'], "import() inside ${} is code");
  assert.deepEqual(flagged('// const MODEL = "openai/gpt-6";\nconst id = "openai/gpt-6";'), ['workflows/x.ts names the model "openai/gpt-6".']);
});

test("mask: comments blanked in text; strings, templates and regexes also in code; offsets and lines kept", () => {
  const src = 'a("x//y"); // c\nb(/[/"]/, `t${ {k: "v"}.k }u`) /* d\n*/ / 2;';
  const { text, code } = mask(src);
  assert.equal(text, 'a("x//y");     \nb(/[/"]/, `t${ {k: "v"}.k }u`)     \n   / 2;');
  assert.equal(code, 'a("    ");     \nb(/    /, ` ${ {k: " "}.k } `)     \n   / 2;');
});

test("parseSkill: name and description from front matter, the body without it", () => {
  assert.deepEqual(parseSkill("---\nname: email-copywriting\ndescription: Writes cold emails.\n---\n# Email\n\nBody"),
    { name: "email-copywriting", description: "Writes cold emails.", body: "# Email\n\nBody" });
  assert.equal(parseSkill("---\nname: 'x'\ndescription: \"Say \\\"hi\\\": now\"\n---\n").description, 'Say "hi": now');
  assert.equal(parseSkill("---\ndescription: >\n  Folded\n  text.\nname: y\n---\nB").description, "Folded text.");
  assert.equal(parseSkill("---\ndescription: Plain that\n  continues.\n---\nB").description, "Plain that continues.");
  assert.deepEqual(parseSkill("# No front matter"), { body: "# No front matter" });
});
