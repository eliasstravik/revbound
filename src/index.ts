/**
 * revbound: defineRevbound and definePlugin for revbound.config.ts, the plugin contract (`api: 1`), the slot interfaces
 * (`V1`) and the workflow registry types. Plain data only: the CLI reads revbound.config.ts, the app reads what `revbound sync`
 * generates from it.
 */
import type { RevboundConfig, RevboundPlugin } from "./core/types.js";

export type * from "./core/types.js";
export { WEBHOOK } from "./kit/brand.js";

/** The contract version this package speaks. */
export const API = 1;

/** The project's plugin list, as revbound.config.ts exports it. */
export function defineRevbound(config: RevboundConfig): RevboundConfig {
  return config;
}

/** A plugin: plain data whose code fields are module specifiers. */
export function definePlugin<P extends RevboundPlugin>(plugin: P): P {
  return plugin;
}
