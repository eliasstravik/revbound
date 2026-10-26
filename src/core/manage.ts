/** `revbound add`, `remove`, `eject` and `diff`: plugin management. None of them edits revbound.config.ts except eject's import flip. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CONFIG, loadConfig, OPTIONAL, PACKAGE, packageDir, projectJiti } from "./config.js";
import { findProject, readJson } from "./project.js";
import { listFiles, schemaOf, sync } from "./sync.js";
import type { RevboundPlugin } from "./types.js";

const EJECT = ".revbound-eject";

/**
 * `revbound add <name | npm-or-git-spec>`: a first-party optional plugin (`mdm`) needs no install; a package is installed
 * pinned. Either way it prints the lines to add to revbound.config.ts.
 */
export async function add(args: string[]): Promise<void> {
  const [spec] = args;
  if (!spec || args.length > 1) throw new Error(`Usage: revbound add <${OPTIONAL.join(" | ")} | npm package[@version] | git url#<commit>>`);
  const own = spec.startsWith(`${PACKAGE}/`) ? spec.slice(PACKAGE.length + 1) : spec;
  if ((OPTIONAL as readonly string[]).includes(own)) {
    const dir = findProject();
    if ((await loadConfig(dir)).plugins.some((p) => p.name === own)) return void console.log(`${own} is already in ${CONFIG}.`);
    console.log(`${own} ships with ${PACKAGE}; nothing to install. Add these lines to ${CONFIG}, then run \`npx revbound sync\` and \`npx revbound migrate\`:\n`);
    console.log(`  import { ${own} } from "${PACKAGE}/${own}";`);
    console.log(`  ${own}(),   // in plugins: [...]`);
    return;
  }
  const git = /^(git\+|github:|gitlab:|bitbucket:|https?:\/\/.*\.git|git@)/.test(spec) || /^[\w-]+\/[\w.-]+(#.*)?$/.test(spec);
  if (git && !/#[0-9a-f]{40}$/.test(spec)) throw new Error("A git plugin must name a commit: <url>#<40-character commit sha>, so every install gets the same code.");
  const dir = findProject();
  const before = Object.keys(readJson(join(dir, "package.json"))?.dependencies ?? {});
  const npm = spawnSync("npm", ["install", "--save-exact", spec], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (npm.status !== 0) throw new Error("npm install failed; see above.");
  const deps = readJson(join(dir, "package.json"))?.dependencies ?? {};
  const name = Object.keys(deps).find((d) => !before.includes(d)) ?? (spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]);
  const mod = (await projectJiti(dir).import(name).catch(() => ({}))) as Record<string, unknown>;
  const found = Object.entries(mod).find(([, v]) => typeof v === "function" && (() => { try { return (v as () => RevboundPlugin)()?.api === 1; } catch { return false; } })());
  const factory = found?.[0] ?? "plugin";
  console.log(`\nInstalled ${name}. Add these lines to ${CONFIG}, then run \`npx revbound sync\`:\n`);
  console.log(`  import { ${factory} } from "${name}";`);
  console.log(`  ${factory}(),   // in plugins: [...]`);
}

/** `revbound remove <name>`: prints the lines to delete and how to drop its tables; never drops anything. */
export async function remove(args: string[]): Promise<void> {
  const [name] = args;
  if (!name || args.length > 1) throw new Error("Usage: revbound remove <plugin name>");
  const dir = findProject(), config = await loadConfig(dir);
  const p = config.plugins.find((x) => x.name === name);
  if (!p) throw new Error(`No plugin named ${name} in ${CONFIG}.`);
  const text = readFileSync(join(dir, CONFIG), "utf8").split("\n");
  const lines = text.map((l, i) => [i + 1, l] as const).filter(([, l]) => new RegExp(`\\b${name.replace(/-/g, "[-_]?")}\\b`, "i").test(l) && /import|\(/.test(l));
  const dependents = config.plugins.filter((x) => x !== p && (x.needs ?? []).some((s) => (p.provides ?? []).includes(s)));
  console.log(`To remove ${name}, delete these lines from ${CONFIG}, then run \`npx revbound sync\`:\n`);
  for (const [n, l] of lines) console.log(`  ${CONFIG}:${n}  ${l.trim()}`);
  if (dependents.length) console.log(`\n${dependents.map((d) => d.name).join(", ")} ${dependents.length === 1 ? "needs" : "need"} it; \`npx revbound check\` will say so until you remove or replace ${dependents.length === 1 ? "it" : "them"} too.`);
  if (p.migrations || p.schema) console.log(`\nIts tables stay. To drop them after a backup: psql "$DATABASE_URL" -c 'drop schema ${schemaOf(p)} cascade'`);
}

/** The package's source folder of a base plugin. */
function sourceOf(dir: string, name: string): { src: string; version: string } {
  const root = packageDir(dir, PACKAGE);
  const src = root && join(root, "src", "plugins", name);
  if (!root || !src || !existsSync(join(src, "index.ts"))) throw new Error(`${name} is not a plugin of ${PACKAGE}; only its plugins can be ejected.`);
  return { src, version: readJson(join(root, "package.json"))?.version ?? "unknown" };
}

/** Copies a plugin's source to `to`, its own package subpaths turned into project paths under plugins/<name>/, and its
 * relative imports without `.js`. */
function copyPlugin(src: string, to: string, name: string): void {
  rmSync(to, { recursive: true, force: true });
  cpSync(src, to, { recursive: true });
  for (const f of listFiles(to)) {
    if (!/\.(ts|tsx)$/.test(f)) continue;
    const file = join(to, f), text = readFileSync(file, "utf8");
    const own = (sub: string) => new RegExp(`${PACKAGE.replace("/", "\\/")}/${sub}(?=[/"'#\`])`, "g");
    // Relative imports lose their `.js`: the package compiles with NodeNext, a project's bundler resolves `./x` to x.ts.
    const next = text.replace(own(`src/plugins/${name}`), `./plugins/${name}`).replace(own(name), `./plugins/${name}`)
      .replace(/((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)\.js(["'])/g, "$1$2$3");
    if (next !== text) writeFileSync(file, next);
  }
}

/** `revbound eject <name>`: copies a package plugin into plugins/<name>/, keeps a pristine copy, flips the config import, syncs. */
export async function eject(args: string[]): Promise<void> {
  const [name] = args;
  if (!name || args.length > 1) throw new Error("Usage: revbound eject <plugin name>");
  const dir = findProject(), target = join(dir, "plugins", name);
  if (existsSync(join(target, "index.ts"))) throw new Error(`plugins/${name} already exists; \`npx revbound diff ${name}\` shows upstream changes.`);
  const { src, version } = sourceOf(dir, name);
  const configText = readFileSync(join(dir, CONFIG), "utf8");
  const from = `"${PACKAGE}/${name}"`;
  if (!configText.includes(from)) throw new Error(`${CONFIG} does not import ${from}; eject works on a plugin imported from the package.`);
  copyPlugin(src, target, name);
  mkdirSync(join(target, EJECT), { recursive: true });
  copyPlugin(src, join(target, EJECT, "src"), name);
  writeFileSync(join(target, EJECT, "version"), `${version}\n`);
  writeFileSync(join(dir, CONFIG), configText.replace(from, `"./plugins/${name}"`));
  console.log(`Ejected ${name} (from ${PACKAGE} ${version}) into plugins/${name}; ${CONFIG} now imports it from there.`);
  if (name === "ledger") console.log(`The ledger guard now fails until ${CONFIG} sets acknowledge: { customLedger: true }; a custom ledger stops getting safety fixes.`);
  await sync(dir);
}

/** `revbound diff <name>`: offline, what changed upstream between the ejected version and the installed one. */
export async function diff(args: string[]): Promise<void> {
  const [name] = args;
  if (!name || args.length > 1) throw new Error("Usage: revbound diff <plugin name>");
  const dir = findProject(), pristine = join(dir, "plugins", name, EJECT, "src");
  if (!existsSync(pristine)) throw new Error(`plugins/${name} was not ejected with revbound eject (no ${EJECT}/).`);
  const { src, version } = sourceOf(dir, name);
  const from = readFileSync(join(dir, "plugins", name, EJECT, "version"), "utf8").trim();
  const upstream = join(dir, ".revbound", "diff", name);
  copyPlugin(src, upstream, name);
  const rel = (p: string) => relative(dir, p).split(sep).join("/");
  const out = spawnSync("git", ["diff", "--no-index", "--stat", "--patch", rel(pristine), rel(upstream)], { cwd: dir, encoding: "utf8" });
  rmSync(upstream, { recursive: true, force: true });
  if (out.error) throw new Error("revbound diff needs git on PATH.");
  if (!out.stdout.trim()) console.log(`No upstream changes to ${name} between ${from} and ${version}.`);
  else console.log(`Upstream changes to ${name}, ${from} → ${version}:\n\n${out.stdout}`);
  console.log(`Your own edits: git diff --no-index plugins/${name}/${EJECT}/src plugins/${name}`);
}
