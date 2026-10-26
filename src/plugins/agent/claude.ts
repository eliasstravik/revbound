/**
 * The chat agent's model on a laptop signed in to `claude` and holding no API key: an AI SDK language model whose every
 * call is one `claude -p` run with all of Claude Code's own tools off. eve's loop stays in charge: the model only
 * answers with text and the tool calls it wants, as structured output, and eve runs the tools. Laptop only.
 */
import type {
  LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult, LanguageModelV4Prompt,
  LanguageModelV4StreamPart, LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** Everything `claude` needs to find its own login and config; nothing of the app's. */
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|SYSTEMROOT|SystemRoot|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/;

/** What each call must return: the reply text and the tool calls, each with its input as JSON text. */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "What you say to the person now; empty when you only call tools." },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, arguments: { type: "string", description: "The tool's input as a JSON object, written as text." } },
        required: ["name", "arguments"],
        additionalProperties: false,
      },
    },
  },
  required: ["text", "tool_calls"],
  additionalProperties: false,
} as const;

type Reply = { text: string; calls: { name: string; input: string }[]; usage: { input: number; output: number } };
type Tools = LanguageModelV4CallOptions["tools"];

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** The system prompt: eve's own, then how to call the tools this turn offers. */
export function systemPrompt(prompt: LanguageModelV4Prompt, tools: Tools, choice: LanguageModelV4CallOptions["toolChoice"]): string {
  const system = prompt.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
  const fns = (tools ?? []).flatMap((t) => (t.type === "function" ? [t] : []));
  if (!fns.length || choice?.type === "none") return `${system}\n\nAnswer in \`text\`; leave \`tool_calls\` empty.`;
  const list = fns.map((t) => `### ${t.name}\n${t.description ?? ""}\nInput JSON Schema: ${JSON.stringify(t.inputSchema)}`).join("\n\n");
  return `${system}

# Calling tools

You cannot run anything yourself. To use a tool, add it to \`tool_calls\` with its name and its input as JSON text; you get
each result in the next message. Call several tools at once only when they do not depend on each other. When you are
done, answer in \`text\` with \`tool_calls\` empty.${choice?.type === "required" ? " Call at least one tool now." : ""}${choice?.type === "tool" ? ` Call ${choice.toolName} now.` : ""}

## Tools

${list}`;
}

/** The conversation so far as one text, oldest first; tool calls and results keep their ids so results pair up. */
export function transcript(prompt: LanguageModelV4Prompt): string {
  const out: string[] = [];
  for (const m of prompt) {
    if (m.role === "system") continue;
    for (const part of m.content) {
      if (part.type === "text") out.push(`<${m.role === "assistant" ? "assistant" : "user"}>\n${part.text}\n</${m.role === "assistant" ? "assistant" : "user"}>`);
      else if (part.type === "file") out.push(`<${m.role}>[a file${part.filename ? ` named ${part.filename}` : ""}, ${part.mediaType}, not shown]</${m.role}>`);
      else if (part.type === "tool-call") out.push(`<tool_call id="${part.toolCallId}" name="${part.toolName}">${asText(part.input)}</tool_call>`);
      else if (part.type === "tool-result") {
        const o = part.output;
        const value = o.type === "execution-denied" ? `denied${o.reason ? `: ${o.reason}` : ""}` : "value" in o ? asText(o.value) : asText(o);
        out.push(`<tool_result id="${part.toolCallId}" name="${part.toolName}">${value}</tool_result>`);
      }
    }
  }
  return `${out.join("\n\n")}\n\nContinue the conversation as the assistant.`;
}

/** `claude -p` arguments for one call. */
export function claudeArgs(system: string, model?: string): string[] {
  const args = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--tools", "",
    "--system-prompt", system, "--json-schema", JSON.stringify(REPLY_SCHEMA)];
  if (model) args.push("--model", model);
  return args;
}

/** claude's `--output-format json` reply → text, tool calls and usage, or an error saying what came back. */
export function parseReply(out: string): Reply {
  let r: { is_error?: boolean; result?: string; subtype?: string; structured_output?: unknown; usage?: Record<string, number> };
  try { r = JSON.parse(out); } catch { throw new Error(`claude returned no JSON reply; it began: ${out.slice(0, 200)}`); }
  if (r.is_error) throw new Error(`claude reported an error: ${String(r.result ?? r.subtype ?? "").slice(0, 300)}`);
  let value = r.structured_output as { text?: unknown; tool_calls?: { name?: unknown; arguments?: unknown }[] } | undefined;
  if (!value) {
    try { value = JSON.parse(String(r.result ?? "").trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")); } catch { value = { text: r.result ?? "" }; }
  }
  const u = r.usage ?? {};
  return {
    text: typeof value?.text === "string" ? value.text : "",
    calls: (value?.tool_calls ?? []).filter((c) => typeof c?.name === "string").map((c) => ({ name: String(c.name), input: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) })),
    usage: { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), output: u.output_tokens ?? 0 },
  };
}

/** A reply as AI SDK content: tool calls with unknown names or bad JSON come back as text, so the model can correct itself. */
export function toContent(reply: Reply, tools: Tools, id: () => string): { content: LanguageModelV4Content[]; calls: number } {
  const names = new Set((tools ?? []).map((t) => t.name));
  const content: LanguageModelV4Content[] = [], problems: string[] = [];
  for (const c of reply.calls) {
    let ok = names.has(c.name);
    if (ok) { try { JSON.parse(c.input); } catch { ok = false; } }
    if (ok) content.push({ type: "tool-call", toolCallId: id(), toolName: c.name, input: c.input });
    else problems.push(`(I tried to call ${c.name} with input that is not ${names.has(c.name) ? "JSON" : "a tool here"}.)`);
  }
  const text = [reply.text, ...problems].filter(Boolean).join("\n\n");
  if (text) content.unshift({ type: "text", text });
  return { content, calls: content.filter((c) => c.type === "tool-call").length };
}

const usageOf = (u: Reply["usage"]): LanguageModelV4Usage => ({
  inputTokens: { total: u.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: u.output, text: u.output, reasoning: undefined },
});

/** Runs `claude` with the prompt on stdin, in a neutral temp folder, with only its own login's environment. */
async function runClaude(args: string[], stdin: string, signal?: AbortSignal): Promise<string> {
  const [{ spawn }, fs, os, path] = await Promise.all([import("node:child_process"), import("node:fs"), import("node:os"), import("node:path")]);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => KEEP.test(e[0]) && e[1] != null));
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "revbound-chat-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.REVBOUND_CLAUDE_BIN || "claude", args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], signal });
      let out = "", err = "";
      child.stdout.on("data", (d: Buffer) => { out += d; });
      child.stderr.on("data", (d: Buffer) => { err = (err + d).slice(-2000); });
      child.stdin.on("error", () => undefined);
      child.on("error", (e: NodeJS.ErrnoException) => reject(e.code === "ENOENT" ? new Error("claude is not on PATH: install it and sign in, or set an API key (npx revbound docs agent)") : e));
      child.on("close", (code: number | null) => (code === 0 || out.trim().startsWith("{") ? resolve(out) : reject(new Error(`claude exited with ${code}: ${err.trim().slice(0, 300)}`))));
      child.stdin.end(stdin);
    });
  } finally {
    await fs.promises.rm(cwd, { recursive: true, force: true });
  }
}

/** The model eve's agent loop calls; `model` is a Claude model id such as "claude-haiku-5-5" (else claude's default). */
export function claudeCli(model?: string): LanguageModelV4 {
  let n = 0;
  const id = () => `call_${Date.now().toString(36)}_${(n += 1)}`;
  async function generate(o: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const out = await runClaude(claudeArgs(systemPrompt(o.prompt, o.tools, o.toolChoice), model), transcript(o.prompt), o.abortSignal);
    const reply = parseReply(out);
    const { content, calls } = toContent(reply, o.tools, id);
    return { content, finishReason: { unified: calls ? "tool-calls" : "stop", raw: undefined }, usage: usageOf(reply.usage), warnings: [] };
  }
  return {
    specificationVersion: "v4",
    provider: "claude-cli",
    modelId: model ?? "claude",
    supportedUrls: {},
    doGenerate: generate,
    async doStream(o) {
      const r = await generate(o);
      const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
      for (const c of r.content) {
        if (c.type === "text") parts.push({ type: "text-start", id: "t0" }, { type: "text-delta", id: "t0", delta: c.text }, { type: "text-end", id: "t0" });
        else parts.push(c as LanguageModelV4StreamPart);
      }
      parts.push({ type: "finish", usage: r.usage, finishReason: r.finishReason });
      return { stream: new ReadableStream({ start(controller) { for (const p of parts) controller.enqueue(p); controller.close(); } }) };
    },
  };
}
