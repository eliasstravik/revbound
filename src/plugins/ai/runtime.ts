/**
 * What `#revbound/ai` exports: agent() and tool(). Workflow scope runs the loop; every model call, tool call, skill read and
 * CLI stage is one of the ai plugin's steps (step.ts), where each model call is reserved before and settled after.
 * Workflow-safe: no Node imports and no provider clients here.
 */
import type { ModelMessage, Tool, ToolSet } from "ai";
import { z } from "zod";
import type { Runtime } from "revbound";
import { SKILL_NAME, SKILLS_DIR } from "revbound/kit/skill";
import type { CliBackend, Reasoning, Usage } from "./cli.js";
import { sanitizeSchema, type Route } from "./models.js";
import type { McpServer, McpToolDefinition } from "./tools.js";

export type { CliBackend, McpServer, Reasoning, ToolSet, Usage };

export type AgentTools = {
  /** Hosted MCP servers by name (letters, digits, _ and -). Their tools are listed in a step per stage; each call is a step. */
  mcp?: Record<string, McpServer>;
  /** `search`: the Gateway's search, the provider's own on an API key, the CLI's own on a laptop. `fetch`: fetch_page (a step, public addresses only). */
  web?: { search?: boolean; fetch?: boolean };
  /** Your own tools, made with tool(); give each `execute` a "use step" function. They need AI Gateway or an API key. */
  custom?: ToolSet;
};

export type AgentOptions<T = string> = {
  /** Stable id shown in the trace; use the stage function's name. */
  name: string;
  instructions: string;
  prompt: string;
  /** Company skills by folder name: each `.agents/skills/<name>/SKILL.md` body (no front matter) is added to the instructions. */
  skills?: string[];
  /** The result the agent must return; plain text when omitted. Use nullable fields, not optional ones, and no string formats. */
  schema?: z.ZodType<T>;
  /** A Gateway model id; defaults to REVBOUND_MODEL, else the default that follows REVBOUND_AGENT_BACKEND. */
  model?: string;
  reasoning?: Reasoning;
  tools?: AgentTools;
  /** Model calls, tool turns included. Default 20; when reached, one last call without tools writes up the result. Not on the CLI path. */
  maxSteps?: number;
  /** Output tokens per model call, passed to the model so each reservation is a real ceiling. Default 4,096. */
  maxOutputTokens?: number;
  /**
   * Soft spend cap for the stage in USD: after the call that reaches it, one last call without tools writes up the result.
   * For a model with no known price it is also the reservation of each call. claude: `--max-budget-usd`.
   */
  maxUsd?: number;
  /** Wall-clock limit ("90s", "5m", "1h", or milliseconds) of the CLI path. Default "10m". */
  timeout?: string | number;
};

export type AgentToolCall = { tool: string; input: unknown; ok: boolean; costUsd: number };

export type AgentResult<T = string> = {
  value: T;
  /** Metered model cost plus tool-reported cost; 0 on the CLI path (plan usage, not metered). */
  costUsd: number;
  modelCalls: number;
  toolCalls: AgentToolCall[];
  usage: Usage;
  stopReason: "done" | "maxSteps" | "maxUsd";
};

/** A tool definition as it crosses into the model step: JSON only. */
export type ToolDef = { name: string; description?: string; inputSchema: Record<string, unknown>; strict?: boolean };
export type ModelRequest = {
  name: string; route: Route; system: string; messages: ModelMessage[]; tools: ToolDef[]; web: boolean; schema?: Record<string, unknown>;
  maxOutputTokens: number; reasoning?: Reasoning; maxUsd?: number; final: boolean;
};
export type ModelReply = {
  calls: { toolCallId: string; toolName: string; input: unknown }[]; messages: ModelMessage[]; output?: unknown; costUsd: number;
  usage: Usage; toolCosts: { toolName: string; input: unknown; costUsd: number }[];
};

export type Api = {
  /** Every AI call in a workflow, one-shot (no tools) or tool-using. Call it from workflow scope, never inside a step. */
  agent<T = string>(opts: AgentOptions<T>): Promise<AgentResult<T>>;
  /** A custom tool for `tools.custom` (the AI SDK's tool()). */
  tool<I, O>(t: Tool<I, O>): Tool<I, O>;
};

const WRAP_UP = "Stop using tools now. Return the requested result from what you have found so far; use null or empty lists for anything not established.";

/** A custom tool's input schema as JSON Schema (zod, or the AI SDK's jsonSchema()). */
function jsonOf(schema: unknown): Record<string, unknown> {
  const s = schema as { jsonSchema?: unknown; "~standard"?: unknown } | undefined;
  if (s && typeof s === "object" && "~standard" in s) return sanitizeSchema(z.toJSONSchema(s as z.ZodType)) as Record<string, unknown>;
  if (s && typeof s === "object" && s.jsonSchema) return sanitizeSchema(s.jsonSchema) as Record<string, unknown>;
  return { type: "object", properties: {} };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function bind(rt: Runtime): Api {
  return {
    tool: (t) => t,
    async agent<T>(o: AgentOptions<T>): Promise<AgentResult<T>> {
      for (const n of Object.keys(o.tools?.mcp ?? {})) if (!/^[A-Za-z0-9_-]{1,40}$/.test(n)) throw new Error(`Agent ${o.name}: MCP server name ${n} must be letters, digits, _ or -`);
      for (const n of o.skills ?? []) if (!SKILL_NAME.test(n)) throw new Error(`Agent ${o.name}: skill ${JSON.stringify(n)} must be a folder name in ${SKILLS_DIR}`);
      const schema = o.schema ? (sanitizeSchema(z.toJSONSchema(o.schema)) as Record<string, unknown>) : undefined;
      const custom = o.tools?.custom ?? {};
      const route = (await rt.step("route", [{ name: o.name, model: o.model, custom: Object.keys(custom).length > 0 }])) as Route;
      const system = o.skills?.length ? [o.instructions, ...((await rt.step("skills", [o.skills])) as string[])].join("\n\n") : o.instructions;
      const parse = (v: unknown, from: string): T => {
        if (!o.schema) return v as T;
        const r = o.schema.safeParse(v);
        if (r.success) return r.data;
        throw new Error(`Agent ${o.name}: ${from}'s result does not match the schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
      };
      if (route.kind === "cli") {
        const web = Boolean(o.tools?.web?.search || o.tools?.web?.fetch);
        const r = (await rt.once("cli", [{ name: o.name, backend: route.cli, instructions: system, prompt: o.prompt, schema, model: o.model, reasoning: o.reasoning,
          mcp: o.tools?.mcp, web, maxUsd: o.maxUsd, timeout: o.timeout ?? "10m" }])) as { value: unknown; modelCalls: number; usage: Usage };
        return { value: parse(r.value, route.cli ?? "the CLI"), costUsd: 0, modelCalls: r.modelCalls, toolCalls: [], usage: r.usage, stopReason: "done" };
      }

      // Tools cross into the model step as definitions; this loop runs them, each a step.
      const defs: ToolDef[] = Object.entries(custom).map(([name, t]) => ({ name, description: typeof t.description === "string" ? t.description : undefined, inputSchema: jsonOf(t.inputSchema) }));
      const mcp = new Map<string, { server: McpServer; tool: string }>();
      if (o.tools?.web?.fetch) defs.push({ name: "fetch_page", description: "Fetch a public web page and return its readable text, up to about 8,000 characters.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } });
      for (const [server, config] of Object.entries(o.tools?.mcp ?? {})) {
        for (const def of (await rt.step("mcpList", [config])) as McpToolDefinition[]) {
          const name = (def.name.startsWith(`${server}_`) ? def.name : `${server}_${def.name}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
          mcp.set(name, { server: config, tool: def.name });
          defs.push({ name, description: def.description, inputSchema: sanitizeSchema(def.inputSchema) as Record<string, unknown>, strict: false });
        }
      }
      const maxSteps = o.maxSteps ?? 20, maxOutputTokens = o.maxOutputTokens ?? 4096, web = Boolean(o.tools?.web?.search);
      const messages: ModelMessage[] = [{ role: "user", content: o.prompt }];
      const toolCalls: AgentToolCall[] = [], usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let spent = 0, calls = 0, result: unknown, done = false, stopReason: AgentResult["stopReason"] = "done";
      const call = async (final: boolean) => {
        const reply = (await rt.step("model", [{ name: o.name, route, system, messages, tools: final ? [] : defs, web: web && !final, schema,
          maxOutputTokens, reasoning: o.reasoning, maxUsd: o.maxUsd, final } satisfies ModelRequest])) as ModelReply;
        calls += 1; spent += reply.costUsd;
        usage.inputTokens += reply.usage.inputTokens; usage.outputTokens += reply.usage.outputTokens;
        for (const t of reply.toolCosts) { spent += t.costUsd; toolCalls.push({ tool: t.toolName, input: t.input, ok: true, costUsd: t.costUsd }); }
        messages.push(...reply.messages);
        return reply;
      };
      while (!done) {
        if (calls >= maxSteps) { stopReason = "maxSteps"; break; }
        if (o.maxUsd != null && spent >= o.maxUsd) { stopReason = "maxUsd"; break; }
        const reply = await call(false);
        if (!reply.calls.length) { result = reply.output; done = true; break; }
        for (const c of reply.calls) {
          let output: unknown, cost = 0;
          if (c.toolName === "fetch_page") output = await rt.step("fetch", [(c.input as { url?: string })?.url ?? ""]);
          else if (mcp.has(c.toolName)) output = await rt.once("mcpCall", [mcp.get(c.toolName)!.server, mcp.get(c.toolName)!.tool, c.input]);
          else if (custom[c.toolName]?.execute) {
            output = await Promise.resolve(custom[c.toolName].execute!(c.input as never, { toolCallId: c.toolCallId, messages } as never))
              .catch((e: Error) => ({ isError: true, error: e?.message ?? String(e) }));
          } else output = { isError: true, error: `No tool named ${c.toolName}` };
          const r = (output ?? {}) as { costUsd?: unknown; isError?: unknown };
          if (typeof r.costUsd === "number") cost = r.costUsd;
          spent += cost;
          toolCalls.push({ tool: c.toolName, input: c.input, ok: !(r && typeof r === "object" && r.isError), costUsd: round(cost) });
          messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName,
            output: { type: "json", value: (output ?? null) as never } }] });
        }
      }
      if (!done) {
        // maxSteps or maxUsd ended the loop mid-research: one last call, no tools, writes up what was found.
        messages.push({ role: "user", content: WRAP_UP });
        result = (await call(true)).output;
      }
      if (result === undefined || result === "") throw new Error(`Agent ${o.name} returned no result (${stopReason})`);
      return { value: parse(result, route.kind === "gateway" ? "AI Gateway" : route.kind), costUsd: round(spent), modelCalls: calls, toolCalls, usage, stopReason };
    },
  };
}
