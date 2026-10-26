#!/usr/bin/env node
import { join } from "node:path";
import { CORE_COMMANDS, type CliRun } from "./commands.js";
import { packageRoot, readJson } from "./project.js";

type Command = (args: string[]) => Promise<void>;

const USAGE = `revbound: the open-source agent plugin that runs your GTM (npx revbound <command>)

  init [dir] --company <name> [--example]   create a project (default ./gtm-<company>) in an empty folder, or repair one
  sync                      write gtm/ and the shims from gtm.config.ts
  dev                       run the console and workflows on 127.0.0.1:$GTM_PORT (default 3000)
  check [--build] [--prod]  report problems with their fixes (read-only)
  docs [topic]              print the docs of this version
  add <name | npm-or-git>   add a first-party plugin (mdm) or install a plugin package; prints the lines to add
  remove <name>             print the lines that remove a plugin
  eject <name>              copy a package plugin into plugins/<name> to edit it
  diff <name>               what changed upstream since an eject`;

// Loaded on demand so `revbound docs` never loads the database stack.
const core: Record<string, () => Promise<Command>> = {
  init: async () => (await import("./init.js")).init,
  sync: async () => (await import("./sync.js")).syncCommand,
  dev: async () => (await import("./dev.js")).dev,
  check: async () => (await import("./check.js")).check,
  docs: async () => (await import("./docs.js")).docs,
  add: async () => (await import("./manage.js")).add,
  remove: async () => (await import("./manage.js")).remove,
  eject: async () => (await import("./manage.js")).eject,
  diff: async () => (await import("./manage.js")).diff,
};

/** A plugin's command from gtm.config.ts, with its usage line; undefined outside a project or when none has it. */
async function pluginCommand(name: string): Promise<{ run: Command; usage: string[] } | undefined> {
  const [{ findProject }, { loadConfig, projectJiti }] = await Promise.all([import("./project.js"), import("./config.js")]);
  let dir: string;
  try { dir = findProject(); } catch { return undefined; }
  const config = await loadConfig(dir);
  const usage = config.plugins.flatMap((p) => (p.cli ?? []).map((c) => `  ${c.name.padEnd(24)}  ${c.describe} (${p.name})`));
  for (const p of config.plugins) for (const c of p.cli ?? []) if (c.name === name) {
    return {
      usage,
      run: async (args) => {
        const [module, exp = "default"] = c.run.split("#");
        const mod = (await projectJiti(dir).import(module.startsWith(".") ? join(dir, module) : module)) as Record<string, CliRun>;
        await mod[exp](args, { dir, plugin: p.name, options: p.options, config });
      },
    };
  }
  return { usage, run: undefined as never };
}

const [name, ...args] = process.argv.slice(2);
try {
  if (name === "--version" || name === "-v") console.log(readJson(join(packageRoot(), "package.json"))?.version);
  else if (name && core[name] && !args.includes("--help") && !args.includes("-h")) await (await core[name]())(args);
  else {
    const found = name && !CORE_COMMANDS.includes(name) ? await pluginCommand(name).catch(() => undefined) : undefined;
    if (found?.run && !args.includes("--help") && !args.includes("-h")) await found.run(args);
    else {
      const plugins = found?.usage ?? (await pluginCommand("").catch(() => undefined))?.usage ?? [];
      console.log(`${USAGE}${plugins.length ? `\n\nFrom this project's plugins:\n${plugins.join("\n")}` : ""}`);
      if (name && !["help", "--help", "-h"].includes(name) && !core[name]) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`revbound ${name}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
