import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { isGtmProject, packageRoot, readJson } from "./project.js";

/** Entries a folder may already hold and still count as empty. */
const EMPTY_OK = new Set([".git", ".agents", ".claude", "AGENTS.md", "CLAUDE.md"]);
/** Starter paths init writes itself instead of copying them verbatim. */
const SPECIAL = new Set(["gitignore", ".gitignore", "package.json", "AGENTS.md", "CLAUDE.md", ".claude/skills", "node_modules", ".next", "gtm.config.ts"]);
/** Files init restores in an existing project when they are missing (sync restores the shims). */
const RESTORED = ["public/_gtm/probe.txt", "webhooks/index.ts", "workflows/index.ts", ".env.example", "vercel.json"];
const SKILLS_TARGET = "../.agents/skills";

const USAGE = "Usage: revbound init [dir] --company <name> [--example]";

/**
 * `revbound init [dir] [--company <name>] [--example] [--package <spec>] [--no-install]`: copies the starter into an empty
 * folder and writes gtm.config.ts with the seven default plugins, or repairs an existing Revbound project (restores missing
 * wiring, nothing else). Then it installs and runs `revbound sync`. With no dir it repairs the project here, else creates
 * ./gtm-<company>. `--example` (new projects only) adds one small marked example. `--package` (or GTM_PACKAGE_SPEC)
 * replaces the revbound dependency spec; it and `--no-install` are for tests.
 */
export async function init(args: string[]): Promise<void> {
  const options = { company: { type: "string" }, example: { type: "boolean" }, package: { type: "string" }, "no-install": { type: "boolean" } } as const;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (positionals.length > 1) throw new Error(USAGE);
  const here = !positionals[0] && isGtmProject(process.cwd());
  const company = here ? undefined : values.company?.trim() || (positionals[0] ? undefined : await askCompany());
  const dir = resolve(positionals[0] ?? (here ? "." : projectFolder(company!)));
  const starter = join(packageRoot(), "starter");
  const fresh = !isGtmProject(dir);
  if (values.example && !fresh) throw new Error(`${dir} is already a Revbound project; --example is only for a new one.`);
  const repaired = fresh ? [] : repair(dir, starter);
  let backend: string | undefined;
  if (fresh) backend = create(dir, starter, values.package ?? process.env.GTM_PACKAGE_SPEC, company ?? basename(dir).replace(/^gtm-/, ""));
  if (values.example) cpSync(join(packageRoot(), "example"), dir, { recursive: true });
  const installed = values["no-install"] ? false : (fresh || !existsSync(join(dir, "node_modules"))) ? install(dir) : true;
  if (values["no-install"]) console.log("Skipped npm install (--no-install); run `npm install`, then `npx revbound sync`.");
  if (installed) {
    const { sync } = await import("./sync.js");
    await sync(dir, true);
  }
  const rel = relative(process.cwd(), dir) || ".";
  console.log(fresh ? `\nCreated a Revbound project in ${rel}.`
    : `\n${rel} is already a Revbound project: ${repaired.join("; ") || "nothing to restore"}; generated files are current.`);
  if (fresh) console.log(backend ? `AI steps run on your local ${backend} login (GTM_AGENT_BACKEND in .env.local).`
    : "AI steps need a provider key or AI Gateway here: no claude or codex is on PATH (`npx revbound docs ai`).");
  if (values.example) console.log("Added the example: workflows/example-import.ts (`npx revbound run example-import`), its table and context/example-icp.md; the workflow file says how to remove it.");
  console.log(`Next:${rel === "." ? "" : `\n  cd ${rel}`}
  npm run dev                    console on http://127.0.0.1:3000
  npx revbound check             problems with their fixes
  then fill in context/company.md`);
}

/** The folder a company's project gets by default: `gtm-<company>`, lowercase and hyphenated ("Acme Inc" → gtm-acme-inc). */
function projectFolder(company: string): string {
  const slug = company.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").replace(/^gtm-/, "");
  if (!slug || slug === "gtm") throw new Error(`"${company}" gives no folder name; pass the company's name, for example --company Acme.`);
  return `gtm-${slug}`;
}

/** Asks for the company name on a terminal; elsewhere (an agent, CI) the error names the flag. */
async function askCompany(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`Name the company: revbound init --company Acme creates ./gtm-acme (or give a folder). ${USAGE}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Company name (the project goes in ./gtm-<company>): ")).trim();
    if (!answer) throw new Error(`No company name given. ${USAGE}`);
    return answer;
  } finally {
    rl.close();
  }
}

function refuseNonEmpty(dir: string): void {
  if (!existsSync(dir)) return;
  const pkg = readJson(join(dir, "package.json"));
  if (pkg?.dependencies?.next || pkg?.devDependencies?.next || readdirSync(dir).some((f) => f.startsWith("next.config.")))
    throw new Error(`${dir} is an existing Next.js app; adding Revbound to one is not supported yet. Run init in a new folder.`);
  const extra = readdirSync(dir).filter((name) => !EMPTY_OK.has(name));
  if (extra.length) throw new Error(`${dir} is not empty (${extra.slice(0, 5).join(", ")}). Run init in an empty folder or a Revbound project.`);
  const [claude, agents] = [join(dir, ".claude", "skills"), join(dir, ".agents", "skills")];
  const clash = existsSync(claude) && existsSync(agents) ? readdirSync(claude).filter((n) => n !== ".gitkeep" && existsSync(join(agents, n))) : [];
  if (clash.length) throw new Error(`.claude/skills and .agents/skills both hold ${clash.join(", ")}; merge them by hand, then run init again.`);
}

/** The local AI backend: claude under Claude Code, codex under Codex, else whichever is on PATH (claude first). */
export function localBackend(env: NodeJS.ProcessEnv = process.env): "claude" | "codex" | undefined {
  // Codex sets CODEX_THREAD_ID (checked first: Codex may run inside Claude Code); Claude Code sets CLAUDECODE=1.
  if (env.CODEX_THREAD_ID) return "codex";
  if (env.CLAUDECODE === "1") return "claude";
  const onPath = (name: string) => (env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, name)));
  return onPath("claude") ? "claude" : onPath("codex") ? "codex" : undefined;
}

/** Writes the starter; returns the local AI backend it chose. */
function create(dir: string, starter: string, spec: string | undefined, company: string): string | undefined {
  refuseNonEmpty(dir);
  mkdirSync(dir, { recursive: true });
  const rel = (src: string) => relative(starter, src).split(sep).join("/");
  cpSync(starter, dir, { recursive: true, force: false, errorOnExist: false, filter: (src) => !SPECIAL.has(rel(src)) });
  writeFileSync(join(dir, ".gitignore"), readFileSync(join(starter, "gitignore")), { flag: "wx" });
  const agents = join(dir, "AGENTS.md");
  if (!existsSync(agents)) cpSync(join(starter, "AGENTS.md"), agents);
  const claude = join(dir, "CLAUDE.md");
  const text = existsSync(claude) ? readFileSync(claude, "utf8") : "";
  if (!/^@AGENTS\.md\s*$/m.test(text)) writeFileSync(claude, `@AGENTS.md\n${text ? `\n${text}` : ""}`);
  writeFileSync(join(dir, "gtm.config.ts"), readFileSync(join(starter, "gtm.config.ts"), "utf8").replace('company: "Company"', () => `company: ${JSON.stringify(company)}`));
  const companyFile = join(dir, "context", "company.md");
  writeFileSync(companyFile, readFileSync(companyFile, "utf8").replace(/^# .*$/m, () => `# ${company}`));
  const pkg = readJson(join(starter, "package.json"));
  pkg.name = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || pkg.name;
  pkg.dependencies["revbound"] = spec ?? readJson(join(packageRoot(), "package.json")).version;
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  linkSkills(dir, true);
  const backend = localBackend();
  if (backend) writeFileSync(join(dir, ".env.local"), `GTM_AGENT_BACKEND=${backend}\n`, { flag: "wx", mode: 0o600 });
  return backend;
}

/** Restores only the wiring files and the link that are missing. Returns what it did. */
function repair(dir: string, starter: string): string[] {
  const restored: string[] = [];
  for (const file of [...RESTORED, ".gitignore"]) {
    if (existsSync(join(dir, file))) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(starter, file === ".gitignore" ? "gitignore" : file), join(dir, file));
    restored.push(file);
  }
  mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
  if (linkSkills(dir, false)) restored.push(".claude/skills");
  return restored.length ? [`restored ${restored.join(", ")}`] : [];
}

/**
 * Links .claude/skills to .agents/skills (copies when symlinks fail). With `merge` (new projects), an existing folder
 * there is folded into .agents/skills first; otherwise anything already there is left alone. Returns whether it wrote.
 */
function linkSkills(dir: string, merge: boolean): boolean {
  const path = join(dir, ".claude", "skills"), skills = join(dir, ".agents", "skills");
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st && (!merge || (st.isSymbolicLink() && readlinkSync(path) === SKILLS_TARGET))) return false;
  if (st && existsSync(path)) cpSync(path, skills, { recursive: true, force: false, errorOnExist: false, dereference: true });
  if (st) rmSync(path, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  try {
    symlinkSync(SKILLS_TARGET, path, "dir");
  } catch {
    cpSync(skills, path, { recursive: true });
    console.warn("Could not create the symlink .claude/skills; copied .agents/skills there instead. Keep the copy in sync.");
  }
  return true;
}

function install(dir: string): true {
  const result = spawnSync("npm", ["install"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error("npm install failed; fix the error above, then run `npm install` and `npx revbound sync` in the project.");
  return true;
}
