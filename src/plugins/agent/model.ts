/**
 * The chat agent's model, first match wins: `model` (the plugin option) or REVBOUND_CHAT_MODEL as an AI Gateway id; a
 * deployment, AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN → AI Gateway; ANTHROPIC_API_KEY or OPENAI_API_KEY → that
 * provider; else the laptop's own signed-in `codex` (eve's ChatGPT subscription model) or `claude` (claude.ts).
 * The default follows REVBOUND_AGENT_BACKEND, as agent() stages do: Claude Haiku 5.5 for claude, GPT-6 Sol for codex.
 */
import type { LanguageModel } from "ai";
import { anthropic } from "eve/models/anthropic";
import { chatgpt, openai } from "eve/models/openai";
import { value } from "revbound/kit";
import { onVercel } from "./app.js";
import { claudeCli } from "./claude.js";

export const CHAT_MODELS = {
  claude: { gateway: "anthropic/claude-haiku-5.5", provider: "claude-haiku-5-5" },
  codex: { gateway: "openai/gpt-6-sol", provider: "gpt-6-sol" },
} as const;

export type ChatModel =
  | { kind: "gateway"; model: string }
  | { kind: "anthropic" | "openai"; id: string }
  | { kind: "codex" }
  | { kind: "claude"; id?: string };

const family = (env: Record<string, string | undefined>) => (value("REVBOUND_AGENT_BACKEND", env)?.trim().toLowerCase() === "codex" ? "codex" : "claude");

/** Which model the chat runs on here; pure, for tests. */
export function chooseChatModel(option?: string, env: Record<string, string | undefined> = process.env): ChatModel {
  const named = option?.trim() || value("REVBOUND_CHAT_MODEL", env)?.trim();
  const fam = family(env), pick = CHAT_MODELS[fam];
  if (onVercel(env) || value("AI_GATEWAY_API_KEY", env) || value("VERCEL_OIDC_TOKEN", env)) return { kind: "gateway", model: named || pick.gateway };
  const anthropicKey = value("ANTHROPIC_API_KEY", env), openaiKey = value("OPENAI_API_KEY", env);
  if (named) {
    const [vendor, id = ""] = named.includes("/") ? named.split("/", 2) : [/^claude/.test(named) ? "anthropic" : "openai", named];
    const native = vendor === "anthropic" ? id.replace(/\./g, "-") : id;
    if (vendor === "anthropic" && anthropicKey) return { kind: "anthropic", id: native };
    if (vendor === "openai" && openaiKey) return { kind: "openai", id: native };
    if (vendor === "anthropic") return { kind: "claude", id: native };
    if (vendor === "openai") return { kind: "codex" };
    throw new Error(`${named} runs only through AI Gateway: set AI_GATEWAY_API_KEY, or run \`vercel env pull\``);
  }
  if (anthropicKey && (fam === "claude" || !openaiKey)) return { kind: "anthropic", id: CHAT_MODELS.claude.provider };
  if (openaiKey) return { kind: "openai", id: CHAT_MODELS.codex.provider };
  return fam === "codex" ? { kind: "codex" } : { kind: "claude", id: CHAT_MODELS.claude.provider };
}

/** The model as eve's `defineAgent` takes it, with its context window when eve cannot look it up. */
export function chatModel(option?: string): { model: string | LanguageModel; modelContextWindowTokens?: number } {
  const m = chooseChatModel(option);
  if (m.kind === "gateway") return { model: m.model };
  if (m.kind === "anthropic") return { model: anthropic(m.id), modelContextWindowTokens: 200_000 };
  if (m.kind === "openai") return { model: openai(m.id), modelContextWindowTokens: 400_000 };
  if (m.kind === "codex") return { model: chatgpt() };
  return { model: claudeCli(m.id) as unknown as LanguageModel, modelContextWindowTokens: 200_000 };
}
