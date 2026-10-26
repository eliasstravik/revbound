import { isHosted, jwtClaims, value } from "revbound/kit";

/**
 * The one place that names models. The default follows the family the person runs locally (REVBOUND_AGENT_BACKEND),
 * so a hosted copy stays with it: claude -> the newest Claude Haiku, anything else -> GPT-6 Luna. REVBOUND_MODEL (or
 * `model` on a stage) always wins and is a Gateway id ("anthropic/claude-sonnet-5.5").
 * Checked 2026-10-19 against https://ai-gateway.vercel.sh/v1/models and the providers' model lists.
 */
export const MODELS = {
  claude: { gateway: "anthropic/claude-haiku-5.5", provider: "claude-haiku-5-5", family: "anthropic" },
  codex: { gateway: "openai/gpt-6-luna", provider: "gpt-6-luna", family: "openai" },
} as const;

export type Family = "anthropic" | "openai";
export type Default = keyof typeof MODELS;
export type CliBackend = "claude" | "codex";

/** Where one agent() stage runs; an API-key route carries the provider's own model id. */
export type Route = { kind: "gateway"; model: string } | { kind: Family; id: string } | { kind: "cli"; cli?: CliBackend };

/** The default for REVBOUND_AGENT_BACKEND: claude, else codex (GPT-6 Luna). */
export function preferred(): Default {
  return value("REVBOUND_AGENT_BACKEND")?.trim().toLowerCase() === "claude" ? "claude" : "codex";
}

/** The Gateway model for a stage: its own `model`, else REVBOUND_MODEL, else the default that follows REVBOUND_AGENT_BACKEND. */
export function gatewayModel(model?: string): string {
  return model?.trim() || value("REVBOUND_MODEL")?.trim() || MODELS[preferred()].gateway;
}

/** A Gateway id as its own provider names it: "anthropic/claude-sonnet-5.5" -> anthropic "claude-sonnet-5-5". */
export function providerModel(gatewayId: string): { family: Family; id: string } {
  const known = Object.values(MODELS).find((m) => m.gateway === gatewayId);
  if (known) return { family: known.family, id: known.provider };
  const [family, id] = gatewayId.includes("/") ? gatewayId.split("/", 2) : [/^claude/.test(gatewayId) ? "anthropic" : "openai", gatewayId];
  if (family !== "anthropic" && family !== "openai") throw new Error(`${gatewayId} runs only through AI Gateway; set AI_GATEWAY_API_KEY or run \`vercel env pull\``);
  return { family, id: family === "anthropic" ? id.replace(/\./g, "-") : id };
}

const NEEDS_API =
  "custom tools need AI Gateway or an API key: set AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local, or run `vercel env pull` for VERCEL_OIDC_TOKEN";

/** Workflow scope, first match wins: hosted Gateway; laptop Gateway; laptop API key; laptop CLI. */
export function chooseBackend(o: { name: string; model?: string; custom?: boolean }): Route {
  if (isHosted() || value("AI_GATEWAY_API_KEY")) return { kind: "gateway", model: gatewayModel(o.model) };
  const oidc = value("VERCEL_OIDC_TOKEN");
  if (oidc) {
    const { exp } = jwtClaims(oidc);
    if (typeof exp === "number" && exp * 1000 <= Date.now()) throw new Error("VERCEL_OIDC_TOKEN has expired; run `vercel env pull` again");
    return { kind: "gateway", model: gatewayModel(o.model) };
  }
  const keys = { anthropic: value("ANTHROPIC_API_KEY"), openai: value("OPENAI_API_KEY") };
  if (keys.anthropic || keys.openai) {
    const named = o.model?.trim() || value("REVBOUND_MODEL")?.trim();
    if (named) {
      const { family, id } = providerModel(named);
      if (!keys[family]) throw new Error(`Agent ${o.name}: ${named} needs ${family === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} (or AI_GATEWAY_API_KEY)`);
      return { kind: family, id };
    }
    const first = MODELS[preferred()];
    const pick = keys[first.family] ? first : Object.values(MODELS).find((m) => keys[m.family])!;
    return { kind: pick.family, id: pick.provider };
  }
  if (o.custom) throw new Error(`Agent ${o.name}: ${NEEDS_API}`);
  const wanted = value("REVBOUND_AGENT_BACKEND")?.trim().toLowerCase();
  return { kind: "cli", cli: wanted === "claude" || wanted === "codex" ? wanted : undefined };
}

/**
 * The model a CLI gets: the stage's `model` (else REVBOUND_MODEL) as that CLI names it, when it is the CLI's family
 * (anthropic for claude, openai for codex); otherwise undefined, and the CLI uses its own default.
 */
export function cliModel(backend: CliBackend, model?: string): string | undefined {
  const named = model?.trim() || value("REVBOUND_MODEL")?.trim();
  if (!named) return undefined;
  try {
    const { family, id } = providerModel(named);
    return family === (backend === "claude" ? "anthropic" : "openai") ? id : undefined;
  } catch { return undefined; }
}

/**
 * Prices in USD per token by Gateway id, the highest tier of each (so an estimate is a ceiling), from AI Gateway's model
 * list on 2026-10-23. Used on the provider-key path; the Gateway path reads the live list.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-haiku-5.5": { input: 5e-7, output: 2.5e-6 },
  "anthropic/claude-sonnet-5.5": { input: 2e-6, output: 1e-5 },
  "anthropic/claude-opus-5.5": { input: 4e-6, output: 2e-5 },
  "openai/gpt-6-luna": { input: 2e-7, output: 7.5e-7 },
  "openai/gpt-6-sol": { input: 4e-6, output: 1.5e-5 },
  "openai/gpt-6.1-sol": { input: 4e-6, output: 1.5e-5 },
  "openai/gpt-6-astra": { input: 2e-5, output: 7.5e-5 },
};

/** A provider model id back as its Gateway id: anthropic "claude-sonnet-5-5" → "anthropic/claude-sonnet-5.5". */
export function gatewayId(family: Family, id: string): string {
  const known = Object.values(MODELS).find((m) => m.provider === id);
  if (known) return known.gateway;
  return `${family}/${family === "anthropic" ? id.replace(/-(\d+)-(\d+)$/, "-$1.$2") : id}`;
}

/** The ceiling of one call: ceil(prompt characters / 4) × input price + maxOutputTokens × output price. */
export function estimate(price: { input: number; output: number }, promptChars: number, maxOutputTokens: number): number {
  return Math.ceil(promptChars / 4) * price.input + maxOutputTokens * price.output;
}

/** OpenAI's strict JSON schema rejects string formats, and `claude --json-schema` the $schema key; the model reads the description instead. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "$schema" || k === "format") continue;
    const map = k === "properties" || k === "definitions" || k === "$defs";
    out[k] = map && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([p, x]) => [p, sanitizeSchema(x)])) : sanitizeSchema(v);
  }
  return out;
}
