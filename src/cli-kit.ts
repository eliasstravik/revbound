/** Helpers for plugins' CLI commands, dev hooks and checks (Node, CLI only). */
export { BASE, CONFIG, filePath, loadConfig, packageDir, PACKAGE, projectJiti } from "./core/config.js";
export { findProject, isRevboundProject, loadEnv, packageRoot, readJson } from "./core/project.js";
export { byNeeds, schemaOf, sync } from "./core/sync.js";
export { imports, mask } from "./core/mask.js";
export type { CliCtx, CliRun } from "./core/commands.js";
export type { DevCtx, DevHandle } from "./core/dev.js";
export type { CheckCtx } from "./core/check.js";
