/**
 * `revbound check [--build] [--prod]`: every rule, implemented once and read-only. `--build` runs the static rules (the first
 * command of every build); the full check adds plugin checks that reach the database; `--prod` adds Vercel's settings.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import { value } from "../kit/env.js";
import { isBranded } from "../kit/brand.js";
import { sameShape, segments } from "../kit/patterns.js";
import { basePlugin, BASE, CONFIG, loadConfig, PACKAGE, projectJiti } from "./config.js";
import { CORE_COMMANDS, CORE_TOPICS } from "./commands.js";
import { imports, mask } from "./mask.js";
import { findProject, loadEnv, packageRoot, readJson } from "./project.js";
import { MATCHER, plan, type Plan, schemaOf, stale } from "./sync.js";
import type { CheckResult, RevboundConfig, RevboundPlugin } from "./types.js";

export type CheckCtx = { dir: string; config: RevboundConfig; plan: Plan; build: boolean; prod: boolean; plugin?: string; options?: unknown };
type Report = { problems: string[]; warnings: string[]; info: string[] };

const ACCESS = ["session", "console", "automation", "cron", "signature", "local", "tailnet"];
const RESERVED = ["api", "_revbound", "_next", ".well-known", "eve"];
const BUILD = "revbound check --build && revbound migrate && next build";
const SYNC = "run `npx revbound sync`";

export async function check(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { build: { type: "boolean" }, prod: { type: "boolean" } } });
  const shellToken = process.env.VERCEL_TOKEN; // only the shell's, never one from env files
  const dir = findProject();
  loadEnv(dir, !values.build);
  const r: Report = { problems: [], warnings: [], info: [] };
  const add = (results: CheckResult[]) => {
    for (const c of results) {
      if (c.level === "error") r.problems.push(c.fix ? `${c.message}\n  Fix: ${c.fix}` : c.message);
      else if (c.level === "warning") r.warnings.push(c.message);
      else r.info.push(c.message);
    }
  };
  let config: RevboundConfig | undefined;
  try { config = await loadConfig(dir); } catch (error) { add([{ level: "error", message: (error as Error).message }]); }
  if (config) {
    const p = await plan(dir, config);
    add(p.warnings.map((message) => ({ level: "warning", message })));
    add(await rules({ dir, config, plan: p, build: Boolean(values.build), prod: Boolean(values.prod) }));
    if (values.prod) add(await prod(dir, config, shellToken));
  }
  console.log(`revbound check${values.build ? " --build" : ""}: ${dir}`);
  for (const p of r.problems) console.log(`\nPROBLEM: ${p}`);
  for (const w of r.warnings) console.log(`\nWARNING: ${w}`);
  console.log(`${r.info.length ? `\n${r.info.join("\n")}\n` : ""}\n${r.problems.length ? `${r.problems.length} problem(s).` : "No problems."}`);
  if (r.problems.length) process.exitCode = 1;
}

/** Every rule for one project; the plugin checks run last, each with its own options. */
export async function rules(c: CheckCtx): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const err = (message: string, fix?: string) => out.push({ level: "error", message, fix });
  const warn = (message: string) => out.push({ level: "warning", message });
  const { dir, config } = c, plugins = config.plugins;

  // Slots.
  const providers = new Map<string, RevboundPlugin[]>();
  for (const p of plugins) for (const s of p.provides ?? []) providers.set(s, [...(providers.get(s) ?? []), p]);
  for (const [s, ps] of providers) {
    if (ps.length > 1) err(`The ${s} slot has two providers: ${ps.map((p) => p.name).join(" and ")}.`, `keep one of them in ${CONFIG}`);
  }
  for (const p of plugins) {
    if ((p.provides ?? []).length && !p.provide) err(`The ${p.name} plugin provides ${p.provides!.join(", ")} but has no \`provide\` module.`, "give it `provide`, the slot implementation");
    for (const s of p.needs ?? []) if (!providers.has(s)) err(`The ${p.name} plugin needs the ${s} slot, which no plugin provides.`, `add the plugin that provides ${s} to ${CONFIG} (the default is ${s}()), or remove ${p.name}`);
    if ((p.capabilities ?? []).length && !providers.has("ledger")) err(`The ${p.name} plugin ${p.capabilities!.join(" and ")}, which needs the ledger, and no plugin provides it.`, `add ledger() to ${CONFIG}`);
  }
  const cycle = needsCycle(plugins);
  if (cycle) err(`The plugins' needs form a cycle: ${cycle.join(" → ")}.`, "drop one of those needs (use `uses` for an optional slot)");

  // Uniqueness and replacements.
  const seen = <T>(items: [T, string][], what: string, fix: string) => {
    const by = new Map<T, string[]>();
    for (const [k, owner] of items) by.set(k, [...(by.get(k) ?? []), owner]);
    for (const [k, owners] of by) if (owners.length > 1) err(`${what} ${JSON.stringify(k)} is declared by ${owners.join(" and ")}.`, fix);
  };
  seen(plugins.map((p) => [p.name, p.name]), "The plugin name", `keep one plugin of each name in ${CONFIG}`);
  seen([...CORE_COMMANDS.map((n) => [n, "Revbound itself"] as [string, string]), ...plugins.flatMap((p) => (p.cli ?? []).map((x) => [x.name, p.name] as [string, string]))], "The CLI command", "rename the plugin's command");
  seen([...CORE_TOPICS.map((n) => [n, "Revbound itself"] as [string, string]), ...plugins.flatMap((p) => Object.keys(p.docs ?? {}).map((t) => [t, p.name] as [string, string]))], "The docs topic", "rename the plugin's topic");
  seen(plugins.flatMap((p) => (p.workflowTabs ?? []).map((t) => [t.id, p.name] as [string, string])), "The workflow tab", "rename one of the tabs");
  for (const folder of c.plan.duplicateSkills) err(`Two plugins install the skill folder ${folder}.`, "rename one of the skills");
  for (const folder of c.plan.skills.keys()) {
    if (existsSync(join(dir, folder)) && !c.plan.installed.includes(folder)) err(`${folder} is a company skill, and a plugin installs a skill of that name.`, "rename the company skill");
  }
  for (const p of plugins) {
    const base = (BASE as readonly string[]).includes(p.name) ? await basePlugin(dir, p.name).catch(() => undefined) : undefined;
    const missing = (base?.runtime?.exports ?? []).filter((e) => !p.runtime?.exports.includes(e));
    if (missing.length) err(`The ${p.name} plugin replaces the default ${p.name} but lacks its runtime exports ${missing.join(", ")}.`, "export them from its runtime, so company code keeps working");
  }

  // The ledger guard: the ledger slot is the package's own ledger(), unless acknowledged.
  const ledger = providers.get("ledger")?.[0];
  if (ledger) {
    const fresh = await basePlugin(dir, "ledger").catch(() => undefined);
    const diff = fresh ? ledgerDiff(ledger, fresh) : ["the package's ledger() could not be loaded"];
    if (diff.length && !config.acknowledge?.customLedger) {
      err(`The ledger slot is not the package's own ledger() (${diff.join("; ")}). A custom ledger decides what runs and what it may spend, and stops getting safety fixes.`,
        `go back to ledger() from ${PACKAGE}/ledger, or set acknowledge: { customLedger: true } in ${CONFIG}`);
    }
    if (diff.length && config.acknowledge?.customLedger) out.push({ level: "info", message: `Ledger: custom (${ledger.name}), acknowledged in ${CONFIG}.` });
  }

  // Routes, views and access.
  for (const p of plugins) for (const r of p.routes ?? []) {
    if (!ACCESS.includes(r.access)) err(`The ${p.name} route ${r.path} has access ${JSON.stringify(r.access)}.`, `use one of ${ACCESS.join(", ")}`);
    if (r.access === "session" && r.methods.some((m) => m !== "GET")) err(`The ${p.name} route ${r.path} is a session route that accepts ${r.methods.join(", ")}.`, "session routes only read: make it GET, or use console for the console's own writes");
    if (!r.methods.length || r.methods.some((m) => m !== "GET" && m !== "POST")) err(`The ${p.name} route ${r.path} has methods ${JSON.stringify(r.methods)}.`, "use GET and/or POST");
  }
  const routes = c.plan.manifest.routes, views = c.plan.manifest.views;
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    const [a, b] = [routes[i], routes[j]];
    if (sameShape(a.path, b.path) && a.methods.some((m) => b.methods.includes(m))) err(`The routes ${a.key} and ${b.key} can match the same path.`, "rename one of them");
    else if (a.key === b.key) err(`The ${a.plugin} plugin declares the route ${a.path} twice.`, "give each route its own path");
  }
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    if (sameShape(views[i].path, views[j].path)) err(`The views ${views[i].plugin}:${views[i].path} and ${views[j].plugin}:${views[j].path} can match the same path.`, "rename one of them");
  }
  for (const v of views) if (RESERVED.includes(segments(v.path)[0] ?? "")) err(`The ${v.plugin} view ${v.path} starts with a reserved segment.`, `start it with anything but ${RESERVED.join(", ")}`);
  for (const p of plugins) for (const r of p.routes ?? []) if (r.access === "signature") {
    const handler = await loadCode(dir, r.handler).catch((e: Error) => e);
    if (handler instanceof Error) err(`The ${p.name} webhook route ${r.path} does not load: ${handler.message}`);
    else if (!isBranded(handler)) err(`The ${p.name} route ${r.path} is a signature route not built with webhook().`, "export default webhook(...) from its handler module, which verifies the sender");
  }

  // Generated files, shims and the layout.
  const old = stale(dir, c.plan);
  if (old.length) err(`Generated files are out of date: ${old.slice(0, 8).join(", ")}${old.length > 8 ? ` and ${old.length - 8} more` : ""}.`, SYNC);
  const read = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return undefined; } };
  const proxy = read("proxy.ts"), route = read("app/api/revbound/[...path]/route.ts");
  if (proxy != null && !proxy.replace(/\s+/g, "").includes(`matcher:${MATCHER}`)) err("proxy.ts's matcher differs from Revbound's.", SYNC);
  if (route != null && !/export const dynamic = "force-dynamic"/.test(route)) err("app/api/revbound/[...path]/route.ts is not force-dynamic.", SYNC);
  // `vercel deploy` uploads no .gitignore, so a Vercel build without one has nothing to check.
  const ignore = read(".gitignore") ?? (process.env.VERCEL === "1" ? undefined : "");
  if (ignore != null) for (const line of readFileSync(join(packageRoot(), "starter", "gitignore"), "utf8").split("\n").filter(Boolean)) {
    if (!ignore.split(/\r?\n/).includes(line)) err(`.gitignore lacks \`${line}\`.`, `add the line \`${line}\``);
  }
  for (const f of ["package.json", "AGENTS.md", "CLAUDE.md", "next.config.ts", ".env.example", "vercel.json", "public/_revbound/probe.txt", "workflows/index.ts"]) {
    if (!existsSync(join(dir, f))) err(`${f} is missing.`, "recreate it as the starter has it (`npx revbound docs layout`)");
  }
  if (!/^@AGENTS\.md\s*$/m.test(read("CLAUDE.md") ?? "@AGENTS.md")) err("CLAUDE.md does not contain `@AGENTS.md`.", "add the line `@AGENTS.md` so Claude Code reads AGENTS.md");
  if (!(read("next.config.ts") ?? "withRevbound(").includes("withRevbound(")) err("next.config.ts does not use withRevbound().", "export default withRevbound({}) as the starter does");
  if (readJson(join(dir, "vercel.json"))?.services?.eve && !plugins.some((p) => p.name === "agent")) {
    err("vercel.json deploys the agent's eve service, and there is no agent plugin.", "delete `services` and the /eve/v1 rewrite from vercel.json, or add agent() back");
  }
  if ((read("public/_revbound/probe.txt") ?? "revbound-probe-v1").trim() !== "revbound-probe-v1") err("public/_revbound/probe.txt is changed.", "make `revbound-probe-v1` its only contents");
  const build = readJson(join(dir, "package.json"))?.scripts?.build;
  if (build !== BUILD) err(`package.json's build script is ${JSON.stringify(build)}.`, `set it to "${BUILD}", so revbound check runs first in every build`);
  const link = join(dir, ".claude", "skills"), st = lstatSync(link, { throwIfNoEntry: false });
  if (!st) err(".claude/skills is missing.", "run `npx revbound init` in the project to recreate the link");
  else if (!st.isSymbolicLink()) warn(".claude/skills is a copy of .agents/skills (symlinks failed here); copy .agents/skills over it after every skill change.");
  else if (readlinkSync(link) !== "../.agents/skills") err(".claude/skills does not point at .agents/skills.", "delete it and run `npx revbound init`");

  // Company code: no direct starts, no AI SDK, plugins only through #revbound/<plugin>.
  out.push(...companyCode(dir, plugins));

  // Migration ids must be unique per plugin schema; acknowledgments must name real ones.
  for (const id of config.acknowledge?.destructive ?? []) {
    if (!/^[a-z0-9-]+:\d{4}$/.test(id)) err(`acknowledge.destructive has ${JSON.stringify(id)}.`, "name migrations as <plugin>:<NNNN> or company:<NNNN>");
  }
  const schemas = new Map<string, string>();
  for (const p of plugins) {
    const s = schemaOf(p);
    if (s === "public" || s === "drizzle") err(`The ${p.name} plugin uses schema ${s}, which is the company's.`, "give it its own schema");
    if (schemas.has(s)) err(`The ${p.name} and ${schemas.get(s)} plugins share schema ${s}.`, "give each its own schema");
    schemas.set(s, p.name);
  }

  // Each plugin's own checks.
  for (const p of plugins) if (p.checks) {
    const run = await loadCode(dir, p.checks).catch((e: Error) => e);
    if (run instanceof Error || typeof run !== "function") { err(`The ${p.name} plugin's checks do not load${run instanceof Error ? `: ${run.message}` : ""}.`); continue; }
    try { out.push(...(await (run as (ctx: CheckCtx) => Promise<CheckResult[]>)({ ...c, plugin: p.name, options: p.options }))); }
    catch (error) { err(`The ${p.name} plugin's checks failed: ${(error as Error).message}`); }
  }
  return out;
}

/** A cycle in `needs` (by providing plugin), as plugin names, or undefined. */
function needsCycle(plugins: RevboundPlugin[]): string[] | undefined {
  const provider = new Map(plugins.flatMap((p) => (p.provides ?? []).map((s) => [s, p] as const)));
  const state = new Map<RevboundPlugin, 1 | 2>();
  const walk = (p: RevboundPlugin, path: RevboundPlugin[]): string[] | undefined => {
    if (state.get(p) === 2) return undefined;
    if (state.get(p) === 1) return [...path.slice(path.indexOf(p)), p].map((x) => x.name);
    state.set(p, 1);
    for (const s of p.needs ?? []) {
      const q = provider.get(s);
      const found = q && q !== p ? walk(q, [...path, p]) : undefined;
      if (found) return found;
    }
    state.set(p, 2);
    return undefined;
  };
  for (const p of plugins) { const c = walk(p, []); if (c) return c; }
  return undefined;
}

/** How a ledger provider's code specifiers differ from the package's own ledger(). */
export function ledgerDiff(p: RevboundPlugin, fresh: RevboundPlugin): string[] {
  const pick = (x: RevboundPlugin) => ({
    provide: x.provide, "runtime.from": x.runtime?.from, "runtime.step": x.runtime?.step, checks: x.checks, migrations: x.migrations,
    ...Object.fromEntries((x.routes ?? []).map((r) => [`route ${r.path}`, `${r.access} ${r.methods.join(",")} ${r.handler}`])),
  });
  const [a, b] = [pick(p), pick(fresh)] as Record<string, unknown>[];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => `${k} differs`);
}

/** The value a code specifier names, loaded in the CLI through jiti. */
async function loadCode(dir: string, spec: string): Promise<unknown> {
  const [module, name = "default"] = spec.split("#");
  const target = module.startsWith(".") ? join(dir, module) : module;
  const mod = (await projectJiti(dir).import(target)) as Record<string, unknown>;
  return mod[name];
}

const AI_MODULE = /^(?:ai|@ai-sdk\/[^/]+)(?:\/.*)?$/;
/** A Gateway-style id or a bare provider id in quotes, except as a stage's own `model:`. */
const MODEL_ID = /(\bmodel\s*:\s*)?["'`]((?:anthropic|openai|google|xai|mistral|meta|deepseek|groq|perplexity|cohere|bedrock|vertex|amazon|alibaba|moonshotai|zai)\/[\w.:-]+|(?:claude|gpt|gemini)-[\w.-]+)["'`]/g;

/** Source files under a project folder, as [project path, text]. */
function sources(dir: string, folder: string): [string, string][] {
  let files: string[] = [];
  try { files = readdirSync(join(dir, folder), { recursive: true }) as string[]; } catch {}
  return files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.split(sep).includes("node_modules") && !f.split(sep).includes(".revbound-eject"))
    .map((f) => [`${folder}/${f.split(sep).join("/")}`, readFileSync(join(dir, folder, f), "utf8")]);
}

/**
 * Files under workflows/, webhooks/ and local plugins/ never import `start` from workflow/api, `ai` or `@ai-sdk/*`
 * (except the folder of a plugin that provides workflows, or that spends and replaces ai), never value-import
 * `revbound/<plugin>` subpaths (a plugin's own folder may use its own), and workflows/ names no model id.
 */
export function companyCode(dir: string, plugins: RevboundPlugin[]): CheckResult[] {
  return codeFindings([...sources(dir, "workflows"), ...sources(dir, "webhooks"), ...sources(dir, "plugins")], plugins);
}

/** companyCode's rules on [project path, text] pairs. */
export function codeFindings(files: [string, string][], plugins: RevboundPlugin[]): CheckResult[] {
  const out: CheckResult[] = [];
  const local = new Map(plugins.map((p) => [p.name, p]));
  for (const [file, text] of files) {
    const owner = file.startsWith("plugins/") ? file.split("/")[1] : undefined, p = owner ? local.get(owner) : undefined;
    const exempt = Boolean(p && ((p.provides ?? []).includes("workflows") || ((p.capabilities ?? []).includes("spends") && p.name === "ai")));
    for (const i of imports(text)) {
      if (i.typeOnly) continue;
      const at = `${file}:${i.line}`;
      if (!exempt && i.spec === "workflow/api" && (i.names.includes("start") || !i.names.length)) {
        out.push({ level: "error", message: `${at} imports start from workflow/api.`, fix: "start runs through the ledger: use fanOut() from #revbound/workflows, or `revbound run`" });
      }
      if (!exempt && AI_MODULE.test(i.spec)) {
        out.push({ level: "error", message: `${at} imports "${i.spec}".`, fix: "call agent() from #revbound/ai for every AI call; custom tools take `tool` from there too (`npx revbound docs ai`)" });
      }
      const sub = i.spec.startsWith(`${PACKAGE}/`) ? i.spec.slice(PACKAGE.length + 1).split("/")[0] : undefined;
      if (sub && local.has(sub) && sub !== owner) {
        out.push({ level: "error", message: `${at} imports ${i.spec} directly.`, fix: `import from #revbound/${sub} instead, so a swap or eject reaches this file` });
      }
    }
    if (file.startsWith("workflows/")) {
      for (const [, own, id] of mask(text).text.matchAll(MODEL_ID)) if (!own) out.push({ level: "error", message: `${file} names the model "${id}".`, fix: "remove it; REVBOUND_MODEL picks the model, and a stage that truly needs another one sets agent()'s `model`" });
    }
  }
  return out;
}

/** `--prod`: production answers with Vercel's login, and the project has no protection holes. */
async function prod(dir: string, config: RevboundConfig, shellToken: string | undefined): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const err = (message: string, fix: string) => out.push({ level: "error", message, fix });
  for (const id of config.acknowledge?.destructive ?? []) out.push({ level: "info", message: `Acknowledged destructive migration: ${id}` });
  if (config.acknowledge?.customLedger) out.push({ level: "info", message: "Acknowledged: a custom ledger (it stops getting the package's safety fixes)." });
  const url = value("REVBOUND_PRODUCTION_URL");
  if (!url) err("REVBOUND_PRODUCTION_URL is not set.", "add it to .env.local (`npx revbound docs deploy`)");
  else {
    const res = await fetch(new URL(url.includes("://") ? url : `https://${url}`), { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
    const location = res instanceof Response ? res.headers.get("location") ?? "" : "";
    if (!(res instanceof Response)) err(`${url} is unreachable: ${res.message}`, "check REVBOUND_PRODUCTION_URL");
    else if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && location.startsWith("https://vercel.com/sso-api")))
      out.push({ level: "info", message: `Production: ${url} answers with Vercel's login` });
    else err(`${url} answers ${res.status} without Vercel's login.`, "turn on Vercel Authentication → All Deployments (`npx revbound docs deploy`)");
  }
  const link = readJson(join(dir, ".vercel", "project.json"));
  if (!link?.projectId) { err("This folder is not linked to a Vercel project.", "run `vercel link`"); return out; }
  const api = vercelApi(shellToken);
  if (!api) { err("No Vercel credentials to read the project's settings.", "set VERCEL_TOKEN in the shell or run `vercel login`"); return out; }
  const query = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...(link.orgId?.startsWith("team_") ? { teamId: link.orgId } : {}), ...extra }).toString();
  try {
    const project = await api(`/v9/projects/${link.projectId}?${query()}`);
    const aliases: unknown[] = [];
    for (let page = 0, until: string | undefined; page < 20; page += 1) {
      const body = await api(`/v4/aliases?${query({ projectId: project.id ?? link.projectId, limit: "100", ...(until ? { until } : {}) })}`);
      aliases.push(...(body.aliases ?? []));
      until = body.pagination?.next == null ? undefined : String(body.pagination.next);
      if (!until) break;
    }
    const found = protectionFindings(project, aliases);
    for (const [what, fix] of found.problems) err(what, fix);
    out.push(...found.info.map((message) => ({ level: "info" as const, message })));
    if (project.autoExposeSystemEnvs !== true) err("System environment variables are not exposed, so Vercel Workflow falls back to a local store and runs fail.", "Project Settings → Environment Variables → Automatically expose System Environment Variables");
    const envs: { key: string; target?: string[] | string }[] = (await api(`/v10/projects/${link.projectId}/env?${query()}`)).envs ?? [];
    if (!envs.some((e) => e.key === "CRON_SECRET" && [e.target].flat().includes("production")))
      err("CRON_SECRET is not set for Production, so crons and the hourly reconcile are refused.", "`vercel env add CRON_SECRET production` with a long random value, then redeploy");
  } catch (error) {
    err(`The Vercel API refused: ${(error as Error).message}`, "check the token or `vercel login`, and that it can read this project");
  }
  return out;
}

/**
 * The Vercel field checks. Problems: `ssoProtection.deploymentType` other than "all" (All Deployments); alias
 * `protectionBypass` entries with scope "alias-protection-override" (a Deployment Protection Exception), "shareable-link",
 * or "user" with access "granted" (an approved access request). Info: the project's automation bypasses by note. Bypass
 * map keys are secrets: only alias names and notes are ever reported.
 */
export function protectionFindings(project: any, aliases: any[]): { problems: [string, string][]; info: string[] } {
  const problems: [string, string][] = [];
  const type = project?.ssoProtection?.deploymentType ?? null;
  if (type !== "all")
    problems.push([`Vercel Authentication is ${type ? `"${type}"` : "off"}, not All Deployments.`, "Project Settings → Deployment Protection → Vercel Authentication → All Deployments"]);
  for (const alias of aliases) {
    for (const bypass of Object.values<any>(alias?.protectionBypass ?? {})) {
      if (bypass?.scope === "alias-protection-override")
        problems.push([`${alias.alias} has a Deployment Protection Exception.`, "remove it under Deployment Protection → Deployment Protection Exceptions"]);
      if (bypass?.scope === "shareable-link") problems.push([`${alias.alias} has a Shareable Link.`, "revoke it under Deployment Protection → Shareable Links"]);
      if (bypass?.scope === "user" && bypass.access === "granted")
        problems.push([`${alias.alias} has an approved access request.`, "revoke it in the Vercel dashboard; invite teammates as Viewers instead"]);
    }
  }
  const notes = Object.values<any>(project?.protectionBypass ?? {}).filter((b) => b?.scope === "automation-bypass").map((b) => b.note || "(no note)");
  const info = [`Bypass secrets: ${notes.length ? notes.join(", ") : "none"}`,
    "Links shared on bare deployment URLs cannot be listed through Vercel's API (the proxy refuses their bypass cookie)"];
  return { problems, info };
}

/** GET against the Vercel API with VERCEL_TOKEN from the shell, else the logged-in `vercel` CLI's session. */
function vercelApi(shellToken: string | undefined): ((path: string) => Promise<any>) | undefined {
  const home = homedir(), { XDG_DATA_HOME: xdg, APPDATA: appData } = process.env;
  const dirs = [xdg && join(xdg, "com.vercel.cli"), join(home, ".local", "share", "com.vercel.cli"),
    join(home, "Library", "Application Support", "com.vercel.cli"), appData && join(appData, "com.vercel.cli", "Data")];
  const found = shellToken ? undefined : dirs.find((d): d is string => Boolean(d) && existsSync(join(d as string, "auth.json")));
  const token = shellToken || (found && readJson(join(found, "auth.json"))?.token);
  const base: string = (found && readJson(join(found, "config.json"))?.api) ?? "https://api.vercel.com"; // the CLI's, if set
  if (!token) return undefined;
  return async (path) => {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status} on ${path.split("?")[0]}`);
    return res.json();
  };
}
