/** Reading gtm.config.ts (CLI only, through jiti) and finding the files plugins name. */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import type { GtmConfig, GtmPlugin } from "./types.js";
import { packageRoot } from "./project.js";

export const CONFIG = "gtm.config.ts";
export const PACKAGE = "revbound";
/** The seven default plugins, in the order `revbound init` writes them. */
export const BASE = ["database", "ledger", "workflows", "ai", "context", "connections", "console"] as const;
/** First-party plugins that ship in the package but join a project only through `revbound add <name>`. */
export const OPTIONAL = ["mdm"] as const;

/** A jiti that resolves from the project (so `revbound/*` is the installed package) and caches nothing. */
export function projectJiti(dir: string) {
  return createJiti(pathToFileURL(join(dir, "package.json")).href, { moduleCache: false, fsCache: false, interopDefault: true });
}

/** The project's gtm.config.ts, loaded fresh. */
export async function loadConfig(dir: string): Promise<GtmConfig> {
  const file = join(dir, CONFIG);
  if (!existsSync(file)) throw new Error(`${CONFIG} is missing. Run \`npx ${PACKAGE} init\` in a new folder, or restore it from git.`);
  let config: GtmConfig;
  try {
    config = (await projectJiti(dir).import(file, { default: true })) as GtmConfig;
  } catch (error) {
    throw new Error(`${CONFIG} does not load: ${(error as Error).message}`);
  }
  if (!config || typeof config.company !== "string" || !Array.isArray(config.plugins)) {
    throw new Error(`${CONFIG} must \`export default defineGtm({ company, plugins: [...] })\`.`);
  }
  for (const [i, p] of config.plugins.entries()) {
    if (!p || typeof p !== "object" || typeof p.name !== "string") throw new Error(`${CONFIG}: plugins[${i}] is not a plugin (call the plugin function, e.g. database()).`);
    if (p.api !== 1) throw new Error(`The ${p.name} plugin speaks plugin API ${JSON.stringify(p.api)}; this Revbound speaks API 1. Install a version of it made for this gtm.`);
  }
  return config;
}

/** A fresh base plugin from the installed package, as `gtm.config.ts` would get it with default options. */
export async function basePlugin(dir: string, name: string): Promise<GtmPlugin | undefined> {
  if (!(BASE as readonly string[]).includes(name)) return undefined;
  return firstParty(dir, name);
}

/** A default or optional plugin of the installed package, with default options. */
export async function firstParty(dir: string, name: string): Promise<GtmPlugin | undefined> {
  const mod = (await projectJiti(dir).import(`${PACKAGE}/${name}`)) as Record<string, () => GtmPlugin>;
  return mod[name]?.();
}

/** Where a package lives, looking up node_modules folders from `dir`. */
export function packageDir(dir: string, name: string): string | undefined {
  if (name === PACKAGE && !existsSync(join(dir, "node_modules", PACKAGE))) return packageRoot();
  for (let d = resolve(dir); ; d = dirname(d)) {
    const candidate = join(d, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(d) === d) return undefined;
  }
}

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
export const packageName = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

/** A plugin file path on disk: project paths (`./plugins/x/docs.md`) from the project, package paths from the package. */
export function filePath(dir: string, spec: string): string | undefined {
  if (spec.startsWith("./") || spec.startsWith("../")) return resolve(dir, spec);
  const name = packageName(spec), root = packageDir(dir, name);
  return root && join(root, spec.slice(name.length + 1));
}
