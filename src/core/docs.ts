import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, filePath, firstParty, loadConfig, OPTIONAL } from "./config.js";
import { findProject, packageRoot, readJson } from "./project.js";
import type { GtmPlugin } from "./types.js";

/**
 * `revbound docs [topic]`: one doc of the installed version, or the list. Core topics are docs/*.md (`recipes/<name>` prints a
 * recipe); every other topic comes from a plugin's `docs`: this project's plugins (outside one, the defaults), then the
 * optional first-party ones, so their docs can be read before `revbound add`.
 */
export async function docs(args: string[]): Promise<void> {
  const dir = join(packageRoot(), "docs");
  const core = new Map((existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), join(dir, f)]));
  let project: string | undefined, plugins: GtmPlugin[] | undefined;
  try { project = findProject(); plugins = (await loadConfig(project)).plugins; } catch {}
  const own = async (names: readonly string[]) => (await Promise.all(names.map((n) => firstParty(packageRoot(), n).catch(() => undefined)))).filter((p): p is GtmPlugin => Boolean(p));
  plugins = [...(plugins ?? (await own(BASE))), ...(await own(OPTIONAL))];
  const topics = new Map(core);
  for (const p of plugins) for (const [t, file] of Object.entries(p.docs ?? {})) {
    const path = filePath(project ?? packageRoot(), file);
    if (path && !topics.has(t)) topics.set(t, path);
  }
  const topic = args[0]?.replace(/\.md$/, "");
  if (topic && topics.has(topic)) return void process.stdout.write(readFileSync(topics.get(topic)!, "utf8"));
  const recipe = topic?.match(/^recipes\/([a-z0-9-]+)\/?$/)?.[1];
  if (recipe && existsSync(join(dir, "recipes", recipe, "README.md"))) return void process.stdout.write(readFileSync(join(dir, "recipes", recipe, "README.md"), "utf8"));
  if (topic) {
    console.error(`No doc "${topic}".`);
    process.exitCode = 1;
  }
  console.log(`Docs for revbound ${readJson(join(packageRoot(), "package.json"))?.version}:`);
  for (const t of [...topics.keys()].sort()) console.log(`  npx revbound docs ${t}`);
}
