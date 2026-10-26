import type { NextConfig } from "next";
import { allowedHosts, basePath } from "../kit/env.js";
import type { Manifest } from "./types.js";

type Phase = string;
type Context = { defaultConfig: NextConfig };
type ConfigInput = NextConfig | ((phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>);
/** A plugin's `next` module: a config transform, or one that needs Next's phase (as the Workflow SDK's does). */
export type NextTransform = (cfg: NextConfig) => NextConfig | ((phase: Phase, ctx: Context) => NextConfig | Promise<NextConfig>);

/**
 * The company's Next.js config with what the plugins add: each plugin's transform from _revbound/next.ts in config order, the
 * files they trace, and allowed dev origins (REVBOUND_ALLOWED_HOSTS). It enforces nothing; `revbound check` does.
 */
export function withRevbound(config: ConfigInput = {}, revbound: { manifest: Manifest; transforms: NextTransform[]; trace?: string[] }) {
  return async (phase: Phase, ctx: Context): Promise<NextConfig> => {
    let cfg = typeof config === "function" ? await config(phase, ctx) : config;
    const includes = { ...cfg.outputFileTracingIncludes };
    includes["/**/*"] = [...new Set([...(includes["/**/*"] ?? []), ...(revbound.trace ?? [])])];
    const base = basePath();
    if (base && !/^(\/[\w-]+)+$/.test(base)) throw new Error(`REVBOUND_BASE_PATH must look like /acme, not ${base}`);
    if (base) cfg = { ...cfg, basePath: cfg.basePath ?? base };
    // next dev's in-place server updates can leave the API route loading a project module's deleted chunk after an edit
    // (webhooks/index.ts, workflows/index.ts) until the next one; reloading the route on each rebuild never does.
    if (phase === "phase-development-server") cfg = { ...cfg, experimental: { turbopackServerFastRefresh: false, ...cfg.experimental } };
    cfg = { ...cfg, outputFileTracingIncludes: includes, allowedDevOrigins: [...new Set([...(cfg.allowedDevOrigins ?? []), ...allowedHosts()])] };
    for (const transform of revbound.transforms) {
      const next = transform(cfg);
      cfg = typeof next === "function" ? await next(phase, ctx) : next;
    }
    return cfg;
  };
}
