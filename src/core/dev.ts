import { spawn } from "node:child_process";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { appPort, basePath, value } from "../kit/env.js";
import { CONFIG, loadConfig, projectJiti } from "./config.js";
import { findProject, loadEnv } from "./project.js";
import { byNeeds, sync } from "./sync.js";
import type { GtmConfig } from "./types.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** What `revbound dev` gives a plugin's dev hook; `env` is the app's environment, which the hook may add to. */
export type DevCtx = { dir: string; port: number; env: NodeJS.ProcessEnv; plugin: string; options: unknown; config: GtmConfig };
/** What a dev hook returns: `started` runs once the app listens, `stop` when revbound dev ends. */
export type DevHandle = { started?(): void; stop?(): Promise<void> | void };

/**
 * `revbound dev`: sync, each plugin's dev hook in needs order (the database plugin serves the local database and migrates),
 * then `next dev` on 127.0.0.1. gtm.config.ts, .env.example and local plugins are watched and re-synced on change.
 */
export async function dev(args: string[]): Promise<void> {
  // next gets the shell's env plus only ours: it reads the env files itself, so a key set with `revbound connections set`
  // applies without a restart.
  const env: NodeJS.ProcessEnv = { ...process.env, GTM_DEV: "1" };
  process.env.GTM_DEV = "1"; // never hosted, whatever env files say
  const dir = findProject();
  const files = [".env.example", ".env.local"].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "")).join("\n");
  env.GTM_SHELL_KEYS = [...new Set([...files.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]))].filter((n) => value(n)).join(",");
  const port = appPort(loadEnv(dir, true));
  const next = nextBin(dir);
  await sync(dir);
  const config = await loadConfig(dir);
  const handles: DevHandle[] = [];
  const stopAll = async () => { for (const h of handles.reverse()) await Promise.resolve(h.stop?.()).catch((e) => console.error(e)); };
  try {
    for (const p of byNeeds(config.plugins)) if (p.dev) {
      const [module, name = "default"] = p.dev.split("#");
      const mod = (await projectJiti(dir).import(module.startsWith(".") ? join(dir, module) : module)) as Record<string, (c: DevCtx) => Promise<DevHandle | void>>;
      const handle = await mod[name]({ dir, port, env, plugin: p.name, options: p.options, config });
      if (handle) handles.push(handle);
    }
  } catch (error) {
    await stopAll();
    throw error;
  }
  const watchers = watchConfig(dir);
  const child = spawn(process.execPath, [next, "dev", "-H", "127.0.0.1", "-p", String(port), ...args],
    { cwd: dir, env: { ...env, PORT: String(port), WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}${basePath()}` }, stdio: "inherit" });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  for (const signal of SIGNALS) process.on(signal, forward);
  for (const h of handles) h.started?.();
  const code = await new Promise<number>((done) => {
    child.once("error", (error) => { console.error(error.message); done(1); });
    child.once("exit", (status, signal) => done(status ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  for (const signal of SIGNALS) process.off(signal, forward);
  for (const w of watchers) w.close();
  await stopAll();
  process.exitCode = code;
}

/** Re-runs sync a moment after gtm.config.ts, .env.example or a local plugin changes. */
function watchConfig(dir: string): FSWatcher[] {
  let timer: NodeJS.Timeout | undefined;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void sync(dir).catch((e: Error) => console.error(`revbound sync: ${e.message}`)), 300);
  };
  const watchers: FSWatcher[] = [];
  const on = (path: string, recursive: boolean, wanted: (file: string) => boolean) => {
    try { watchers.push(watch(path, { recursive }, (_, file) => wanted(String(file ?? "")) && again())); } catch {}
  };
  // The folder, not the files: editors replace a file on save, which ends a watch on it.
  on(dir, false, (f) => f === CONFIG || f === ".env.example");
  if (existsSync(join(dir, "plugins"))) on(join(dir, "plugins"), true, (f) => !f.includes(".gtm-eject") && !f.includes("node_modules"));
  return watchers;
}

/** The project's own `next` CLI script. */
function nextBin(dir: string): string {
  try {
    const pkg = createRequire(join(dir, "package.json")).resolve("next/package.json");
    return join(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.next);
  } catch {
    throw new Error("next is not installed in this project: run `npm install`.");
  }
}
