/** The core shell's own commands and docs topics; plugin ones may not reuse them. */
export const CORE_COMMANDS = ["init", "sync", "dev", "check", "docs", "add", "remove", "eject", "diff", "help"];
export const CORE_TOPICS = ["plugins", "upgrade", "layout", "interaction", "local", "deploy", "recipes"];

/** What a plugin's CLI command module default-exports. */
export type CliCtx = { dir: string; plugin: string; options: unknown; config: import("./types.js").RevboundConfig };
export type CliRun = (args: string[], ctx: CliCtx) => Promise<void>;
