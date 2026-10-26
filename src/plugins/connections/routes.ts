/**
 * The Connections view's routes (session GET), read-only: every declared connection name with its state here, never a
 * value. Locally the state comes from .env.local and the shell; hosted from this deployment's own environment.
 */
import type { About, RegistryInfo, RouteCtx } from "revbound";
import { environment, isHosted, json, value } from "revbound/kit";

type State = "set" | "missing" | "provided";
type Info = Record<string, About & RegistryInfo>;

/** The workflows each connection is used by come from the registry, when a workflows plugin is there. */
const registryOf = async (ctx: RouteCtx): Promise<Info> => (ctx.has("workflows") ? ctx.get("workflows").registry().catch(() => ({})) : {});

/** Names .env.example lists and plugins or workflows declare, with their state here. */
async function rows(ctx: RouteCtx) {
  const hosted = isHosted(), local = hosted ? [] : (await import("revbound/kit/dotenv")).envLocalNames();
  const registry = await registryOf(ctx);
  const declared = new Map(ctx.manifest.connections.map((c) => [c.name, c]));
  for (const [, w] of Object.entries(registry)) for (const n of w.connections ?? []) if (!declared.has(n)) declared.set(n, { name: n, label: "", plugins: [] });
  const shell = (value("GTM_SHELL_KEYS") ?? "").split(",");
  return [...declared.values()].map((c) => {
    const set = value(c.name) !== undefined || local.includes(c.name);
    const state: State = hosted && !set && /^AI_GATEWAY_/i.test(c.name) ? "provided" : set ? "set" : "missing";
    const workflows = Object.entries(registry).filter(([, w]) => w.connections?.includes(c.name)).map(([n]) => n);
    return { name: c.name, label: c.label, state, usedBy: { workflows, plugins: c.plugins }, ...(!hosted && shell.includes(c.name) && { shell: true }) };
  }).sort((a, b) => Number(b.state === "missing") - Number(a.state === "missing"));
}

/** GET /connections → { connections, environment, usageComplete }. */
export async function list(_req: Request, ctx: RouteCtx): Promise<Response> {
  const registry = await registryOf(ctx);
  return json({ connections: await rows(ctx), environment: environment(), usageComplete: Object.values(registry).every((w) => Array.isArray(w.connections)) });
}

/** GET /connections/missing → { count }: the sidebar's badge. */
export async function missing(_req: Request, ctx: RouteCtx): Promise<Response> {
  return json({ count: (await rows(ctx)).filter((r) => r.state === "missing").length });
}
