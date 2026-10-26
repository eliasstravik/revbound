import { FatalError } from "workflow";
import { isHosted } from "revbound/kit";
import { cliModel, type CliBackend } from "./models.js";
import { mcpAuth, type McpServer } from "./tools.js";

/**
 * The laptop-only backend of agent(): the whole stage runs inside one step through the unmodified `claude` or `codex`
 * binary the person is signed into. The CLI runs its own tool loop; it never sees the app's secrets, and MCP keys
 * reach it only through a 0600 file (claude) or an environment variable (codex), never argv.
 */
export type { CliBackend };
export type Reasoning = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Usage = { inputTokens: number; outputTokens: number };

export type CliAgentOptions = {
  /** GTM_AGENT_BACKEND; else whichever binary is on PATH, claude first. */
  backend?: CliBackend;
  instructions: string;
  prompt: string;
  /** JSON Schema, already sanitized; omit for plain text. */
  schema?: Record<string, unknown>;
  /** The stage's Gateway model id; passed on only when it is this CLI's family (cliModel). */
  model?: string;
  reasoning?: Reasoning;
  mcp?: Record<string, McpServer>;
  web: boolean;
  /** claude's --max-budget-usd; codex has no spend cap. */
  maxUsd?: number;
  timeoutMs: number;
};

export type CliAgentResult = { value: unknown; costUsd: number; modelCalls: number; usage: Usage };

/** Everything the CLIs need to find their own login and config; nothing of the app's. CLAUDE* is never passed. */
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|COLORTERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|SYSTEMROOT|SystemRoot|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|CODEX_HOME|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;
const NOTICE = Symbol.for("gtm.planLimitsNotice");

/** Neither CLI has "none" or "minimal" for its default models; both take low, medium, high, xhigh and max. */
const effort = (r: Reasoning) => (r === "none" || r === "minimal" ? "low" : r);

/** `claude -p` arguments; `mcpConfig` is the 0600 file holding the MCP servers (and their keys). */
export function claudeArgs(o: CliAgentOptions, mcpConfig?: string): string[] {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", o.web ? "WebSearch,WebFetch" : ""];
  const model = cliModel("claude", o.model);
  if (model) args.push("--model", model);
  if (o.schema) args.push("--json-schema", JSON.stringify(o.schema));
  if (o.reasoning) args.push("--effort", effort(o.reasoning));
  if (o.maxUsd != null) args.push("--max-budget-usd", String(o.maxUsd));
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  const servers = Object.entries(o.mcp ?? {});
  const allowed = [...(o.web ? ["WebSearch", "WebFetch"] : []), ...servers.flatMap(([n, s]) => s.allow?.map((t) => `mcp__${n}__${t}`) ?? [`mcp__${n}`])];
  if (allowed.length) args.push("--allowedTools", ...allowed);
  return args;
}

/** `codex exec` arguments and the variables that carry MCP keys; `last` gets the final message, `schema` is the schema file. */
export function codexArgs(o: CliAgentOptions, last: string, schema?: string): { args: string[]; env: Record<string, string> } {
  const args = ["exec", "-", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-o", last], env: Record<string, string> = {};
  const model = cliModel("codex", o.model);
  if (model) args.push("-m", model);
  if (schema) args.push("--output-schema", schema);
  if (o.reasoning) args.push("-c", `model_reasoning_effort="${effort(o.reasoning)}"`);
  if (o.web) args.push("-c", `web_search="live"`);
  Object.entries(o.mcp ?? {}).forEach(([n, s], i) => {
    // codex runs MCP tools unattended only when approved up front; the key travels in an env var it reads itself.
    args.push("-c", `mcp_servers.${n}.url=${JSON.stringify(s.url)}`, "-c", `mcp_servers.${n}.default_tools_approval_mode="approve"`);
    if (s.allow) args.push("-c", `mcp_servers.${n}.enabled_tools=${JSON.stringify(s.allow)}`);
    for (const [header, v] of Object.entries(mcpAuth(s))) {
      const bearer = header.toLowerCase() === "authorization" && v.startsWith("Bearer ");
      env[`GTM_MCP_KEY_${i}`] = bearer ? v.slice(7) : v;
      args.push("-c", bearer ? `mcp_servers.${n}.bearer_token_env_var="GTM_MCP_KEY_${i}"`
        : `mcp_servers.${n}.env_http_headers={ ${JSON.stringify(header)} = "GTM_MCP_KEY_${i}" }`);
    }
  });
  return { args, env };
}

/** The first 300 characters of what a CLI wrote, on one line, with anything that looks like a key or token masked. */
export function excerpt(text: string, secrets: string[] = []): string {
  let s = text;
  for (const secret of secrets) if (secret.length >= 8) s = s.replaceAll(secret, "[redacted]");
  s = s.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA|vck|eyJ)[-_A-Za-z0-9.]{12,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s || "(nothing)";
}

type ClaudeReply = { is_error?: boolean; subtype?: string; errors?: string[]; result?: string; structured_output?: unknown; total_cost_usd?: number;
  num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };

/** claude's `--output-format json` reply (it exits 1 on an error reply) → the stage's result, or an error that says what came back. */
export function parseClaude(out: string, o: Pick<CliAgentOptions, "schema" | "maxUsd">, secrets: string[] = []): CliAgentResult {
  let reply: ClaudeReply;
  try { reply = JSON.parse(out); } catch { throw new Error(`claude returned no JSON reply; it began: ${excerpt(out, secrets)}`); }
  if (reply.subtype === "error_max_budget_usd") throw new Error(`claude reached maxUsd ($${o.maxUsd}) before it returned a result`);
  if (reply.is_error) throw new Error(`claude reported an error: ${excerpt(String(reply.result ?? reply.errors?.join("; ") ?? reply.subtype ?? ""), secrets)}`);
  let value: unknown = reply.result ?? "";
  if (o.schema) {
    value = reply.structured_output;
    if (value === undefined) {
      const text = String(reply.result ?? "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
      try { value = JSON.parse(text); } catch { throw new Error(`claude returned no structured output for the schema; its reply began: ${excerpt(text, secrets)}`); }
    }
  }
  const u = reply.usage ?? {};
  return {
    value,
    costUsd: reply.total_cost_usd ?? 0,
    modelCalls: reply.num_turns ?? 1,
    usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 },
  };
}

type CodexEvent = { type?: string; message?: string; error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } };

/** codex's JSON events and its final message (`-o` file; null when it wrote none) → the stage's result, or an error that says what came back. */
export function parseCodex(events: string, last: string | null, o: Pick<CliAgentOptions, "schema">, secrets: string[] = []): CliAgentResult {
  const list = events.split("\n").flatMap((l) => { try { return [JSON.parse(l) as CodexEvent]; } catch { return []; } });
  const failed = list.findLast((e) => e.type === "turn.failed" || e.type === "error");
  const text = last?.trim() ?? "";
  if (!text) {
    const why = failed ? `; it reported: ${excerpt(failed.error?.message ?? failed.message ?? "", secrets)}` : `; it wrote: ${excerpt(events, secrets)}`;
    throw new Error(`codex wrote no final message${why}`);
  }
  let value: unknown = text;
  if (o.schema) {
    try { value = JSON.parse(text); } catch { throw new Error(`codex's final message is not JSON for the schema; it began: ${excerpt(text, secrets)}`); }
  }
  const turns = list.filter((e) => e.type === "turn.completed");
  return {
    value,
    costUsd: 0,
    modelCalls: Math.max(1, turns.length),
    usage: { inputTokens: turns.reduce((n, e) => n + (e.usage?.input_tokens ?? 0), 0), outputTokens: turns.reduce((n, e) => n + (e.usage?.output_tokens ?? 0), 0) },
  };
}

/** One CLI run from a neutral temp folder, killed at the stage's timeout (its step is never retried). */
export async function runAgentCli(o: CliAgentOptions): Promise<CliAgentResult> {
  if (isHosted()) throw new FatalError("The claude and codex backends run only on a laptop");
  const [fs, os, path] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));
  const backend = o.backend ?? (onPath("claude") ? "claude" : onPath("codex") ? "codex" : undefined);
  if (!backend) throw new FatalError("agent() found no AI backend: set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY (npx revbound connections set), run `vercel env pull`, or sign in to `claude` or `codex` on this computer");
  const g = globalThis as { [NOTICE]?: boolean };
  if (!g[NOTICE]) {
    g[NOTICE] = true;
    console.warn(`[revbound] agent() stages run on your own signed-in ${backend}. Big runs may hit your plan's limits` +
      `${backend === "claude" ? ` (Anthropic: plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK")` : ""}.` +
      " Setting AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY moves them to an API.");
  }
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => KEEP.test(e[0]) && e[1] != null));
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gtm-agent-"));
  const file = (name: string, text: string) => fs.promises.writeFile(path.join(dir, name), text, { mode: 0o600 }).then(() => path.join(dir, name));
  const servers = Object.entries(o.mcp ?? {});
  const secrets = servers.flatMap(([, s]) => Object.values(mcpAuth(s)).map((v) => v.replace(/^Bearer /, "")));
  const prompt = `${o.instructions}\n\n---\n\n${o.prompt}`;
  try {
    if (backend === "claude") {
      const config = servers.length
        ? await file("mcp.json", JSON.stringify({ mcpServers: Object.fromEntries(servers.map(([n, s]) => [n, { type: "http", url: s.url, headers: mcpAuth(s) }])) }))
        : undefined;
      const r = await run("claude", claudeArgs(o, config), prompt, dir, env, o.timeoutMs);
      // claude exits 1 with a JSON error reply (a spent budget, a refusal); anything else non-zero is a crash.
      if (r.code !== 0 && !r.out.trim().startsWith("{")) throw new Error(`claude exited with ${r.code}: ${excerpt(r.err || r.out, secrets)}`);
      return parseClaude(r.out, o, secrets);
    }
    const last = path.join(dir, "last.txt");
    const { args, env: keys } = codexArgs(o, last, o.schema && (await file("schema.json", JSON.stringify(o.schema))));
    const r = await run("codex", args, prompt, dir, { ...env, ...keys }, o.timeoutMs);
    const text = await fs.promises.readFile(last, "utf8").catch(() => null);
    if (r.code !== 0 && !text && !/"type":"(?:turn\.failed|error)"/.test(r.out)) throw new Error(`codex exited with ${r.code}: ${excerpt(r.err || r.out, secrets)}`);
    return parseCodex(r.out, text, o, secrets);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Spawns in its own process group so a timeout kills the CLI and anything it started. Resolves with the exit code. */
async function run(cmd: string, args: string[], stdin: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<{ code: number | string; out: string; err: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "", err = "", bytes = 0, done = false;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
    };
    const stop = (error: Error) => {
      if (done) return;
      done = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
      reject(error);
    };
    const timer = setTimeout(() => stop(new Error(`${cmd} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`)), timeoutMs);
    const take = (data: Buffer, toOut: boolean) => {
      bytes += data.length;
      if (bytes > 8_000_000) return stop(new Error(`${cmd} wrote more than 8 MB of output`));
      if (toOut) out += data;
      else err = (err + data).slice(-2000);
    };
    child.stdout.on("data", (d: Buffer) => take(d, true));
    child.stderr.on("data", (d: Buffer) => take(d, false));
    child.stdin.on("error", () => undefined);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (!done) reject(e.code === "ENOENT" ? new FatalError(`${cmd} is not on PATH; install it and sign in, or set GTM_AGENT_BACKEND`) : e);
      done = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      resolve({ code: code ?? signal ?? "unknown", out, err: err.trim() });
    });
    child.stdin.end(stdin);
  });
}
