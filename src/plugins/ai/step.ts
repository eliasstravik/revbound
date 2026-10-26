/**
 * The ai plugin's steps. A model call reserves its ceiling (prompt estimate plus maxOutputTokens at the model's price)
 * before it runs and settles the real cost after; a refusal is a FatalError carrying the ledger's reason.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { gateway, generateText, jsonSchema, Output, tool, type LanguageModel, type ToolSet } from "ai";
import { FatalError, getStepMetadata, getWorkflowMetadata } from "workflow";
import type { Ctx, Manifest, SlotMap } from "revbound";
import { context, parseSkill, SKILLS_DIR } from "revbound/kit";
import { runAgentCli, type CliAgentOptions } from "./cli.js";
import { chooseBackend, estimate, gatewayId, PRICES, type Route } from "./models.js";
import type { ModelReply, ModelRequest } from "./runtime.js";
import { callMcpTool, fetchPage, listMcpTools } from "./tools.js";

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The SDK run and step this call belongs to, for the reservation and its key (`<run>:<step>:<attempt>`). */
function where() {
  const { workflowRunId } = getWorkflowMetadata(), { stepId, attempt } = getStepMetadata();
  return { sdkRunId: workflowRunId, key: `${workflowRunId}:${stepId}:${attempt}` };
}

let gatewayPrices: Promise<Map<string, { input: number; output: number }>> | undefined;
/** AI Gateway's model list, fetched once per instance (before any lock): the highest tier of each price. */
function livePrices() {
  gatewayPrices ??= fetch("https://ai-gateway.vercel.sh/v1/models", { signal: AbortSignal.timeout(10_000) }).then(async (res) => {
    const { data = [] } = (await res.json()) as { data?: { id: string; pricing?: Record<string, unknown> }[] };
    const top = (p: Record<string, unknown>, k: string) => Math.max(Number(p[k] ?? 0), ...((p[`${k}_tiers`] as { cost: string }[] | undefined) ?? []).map((t) => Number(t.cost)));
    return new Map(data.filter((m) => m.pricing?.input != null).map((m) => [m.id, { input: top(m.pricing!, "input"), output: top(m.pricing!, "output") }]));
  }).catch((error) => { gatewayPrices = undefined; throw error; });
  return gatewayPrices;
}

async function priceOf(route: Route): Promise<{ id: string; price?: { input: number; output: number } }> {
  if (route.kind === "gateway") return { id: route.model, price: (await livePrices().catch(() => new Map())).get(route.model) ?? PRICES[route.model] };
  if (route.kind === "cli") return { id: route.cli ?? "cli" };
  const id = gatewayId(route.kind, route.id);
  return { id, price: PRICES[id] };
}

function modelOf(route: Route): LanguageModel {
  if (route.kind === "gateway") return route.model;
  if (route.kind === "anthropic") return anthropic(route.id);
  if (route.kind === "openai") return openai(route.id);
  throw new Error("The CLI path has no model object.");
}

/** One model call, no tool executes (the loop runs tools as their own steps). */
async function model(ctx: Ctx, req: ModelRequest): Promise<ModelReply> {
  const { sdkRunId, key } = where(), ledger = ctx.get("ledger");
  const { id, price } = await priceOf(req.route);
  const est = price ? estimate(price, JSON.stringify([req.system, req.messages, req.tools]).length, req.maxOutputTokens) : req.maxUsd;
  if (est == null) throw new FatalError(`Agent ${req.name}: no known price for ${id}, so the call cannot be reserved. Set maxUsd on the stage.`);
  const r = await ledger.reserve({ sdkRunId, plugin: "ai", kind: "model_call", target: id, idempotencyKey: key, estimateUsd: round(est), detail: { stage: req.name } });
  if (!r.ok) throw new FatalError(`Agent ${req.name}: ${r.reason}`);
  const tools: ToolSet = Object.fromEntries(req.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as never), ...(t.strict === false && { strict: false }) } as never)]));
  if (req.web) {
    tools.web_search = req.route.kind === "gateway" ? gateway.tools.exaSearch() : req.route.kind === "anthropic" ? anthropic.tools.webSearch_20250305() : openai.tools.webSearch();
  }
  try {
    const res = await generateText({
      model: modelOf(req.route), system: req.system, messages: req.messages, maxOutputTokens: req.maxOutputTokens, maxRetries: 0,
      ...(Object.keys(tools).length && { tools }), ...(req.final && { toolChoice: "none" as const }), ...(req.reasoning && { reasoning: req.reasoning }),
      ...(req.schema && { output: Output.object({ schema: jsonSchema(req.schema as never) }) }),
    } as never) as Awaited<ReturnType<typeof generateText>> & { output?: unknown };
    const usage = { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 };
    const reported = (res.providerMetadata?.gateway as { cost?: unknown } | undefined)?.cost;
    const cost = reported != null && Number.isFinite(Number(reported)) ? Number(reported)
      : price ? usage.inputTokens * price.input + usage.outputTokens * price.output : est;
    // Provider-executed tools (web search) may report their own cost.
    const toolCosts = (res.toolResults ?? []).flatMap((t) => {
      const o = t.output as { cost?: { value?: unknown; currency?: unknown } } | undefined;
      return o?.cost?.currency === "USD" && typeof o.cost.value === "number" ? [{ toolName: t.toolName, input: t.input, costUsd: o.cost.value }] : [];
    });
    await ledger.settle(r.id, { costUsd: round(cost + toolCosts.reduce((n, t) => n + t.costUsd, 0)), outcome: "ok", detail: { usage } });
    const calls = (res.toolCalls ?? []).filter((c) => !(c as { providerExecuted?: boolean }).providerExecuted)
      .map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input }));
    let output: unknown;
    if (!calls.length) { try { output = req.schema ? res.output : res.text; } catch { output = undefined; } }
    return { calls, messages: JSON.parse(JSON.stringify(res.response.messages)), output, costUsd: round(cost), usage, toolCosts };
  } catch (error) {
    await ledger.settle(r.id, { outcome: "failed", detail: { error: String((error as Error)?.message ?? error).slice(0, 300) } });
    throw error;
  }
}

/** The whole stage through the signed-in `claude` or `codex`: one call, counted, no money reserved. */
async function cli(ctx: Ctx, o: Omit<CliAgentOptions, "timeoutMs"> & { name: string; timeout: string | number }) {
  const { sdkRunId, key } = where(), ledger = ctx.get("ledger");
  const r = await ledger.reserve({ sdkRunId, plugin: "ai", kind: "model_call", target: o.backend ?? "cli", idempotencyKey: key, estimateUsd: null, detail: { stage: o.name } });
  if (!r.ok) throw new FatalError(`Agent ${o.name}: ${r.reason}`);
  try {
    const res = await runAgentCli({ ...o, timeoutMs: durationMs(o.timeout) });
    await ledger.settle(r.id, { costUsd: null, outcome: "ok", detail: { usage: res.usage, planUsd: res.costUsd } });
    return { value: res.value, modelCalls: res.modelCalls, usage: res.usage };
  } catch (error) {
    await ledger.settle(r.id, { outcome: "failed", detail: { error: String((error as Error)?.message ?? error).slice(0, 300) } });
    throw error;
  }
}

/** "90s", "5m", "1h", "2d", or a number of milliseconds. */
function durationMs(v: string | number): number {
  if (typeof v === "number") return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i.exec(v);
  if (!m) throw new FatalError(`Not a duration: ${v}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "ms"];
}

/** Each named skill's SKILL.md body, front matter dropped, from the project as deployed (the context plugin traces it). */
async function skills(names: string[]): Promise<string[]> {
  const [{ readFile }, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  return Promise.all(names.map(async (n) => {
    const text = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), SKILLS_DIR, n, "SKILL.md"), "utf8").catch(() => null);
    if (text == null) throw new FatalError(`No skill "${n}": agent() reads ${SKILLS_DIR}/${n}/SKILL.md, which does not exist`);
    return parseSkill(text).body.trim();
  }));
}

export async function run(manifest: Manifest, map: SlotMap, op: string, args: unknown[]): Promise<unknown> {
  const ctx = context(manifest, map), [a, b, c] = args as [any, any, any];
  switch (op) {
    case "route": return chooseBackend(a);
    case "skills": return skills(a);
    case "model": return model(ctx, a);
    case "cli": return cli(ctx, a);
    case "fetch": return fetchPage(a);
    case "mcpList": return listMcpTools(a);
    case "mcpCall": return callMcpTool(a, b, c);
    default: throw new Error(`The ai plugin has no step "${op}".`);
  }
}
