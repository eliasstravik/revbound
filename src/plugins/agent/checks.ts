/**
 * The agent plugin's checks: eve installed, `.agents/skills` holding only skills (eve loads each entry as one), and
 * vercel.json deploying the app and the agent as two services with /eve/v1/* routed to the agent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult } from "revbound";
import { type CheckCtx, readJson } from "revbound/cli";
import { parseSkill, SKILLS_DIR } from "revbound/kit";
import { CHANNEL_KEYS, type Channel } from "./index.js";

/** What eve needs of each entry in .agents/skills: a folder whose SKILL.md has a description. */
export function skillProblems(dir: string): CheckResult[] {
  const root = join(dir, SKILLS_DIR), out: CheckResult[] = [];
  const entries = existsSync(root) ? readdirSync(root) : [];
  for (const name of entries) {
    const path = join(root, name), file = join(path, "SKILL.md");
    if (!statSync(path).isDirectory()) {
      out.push({ level: "error", message: `${SKILLS_DIR}/${name} is not a skill folder, and the agent loads every entry there as a skill.`, fix: `move it out of ${SKILLS_DIR}` });
    } else if (!existsSync(file)) {
      out.push({ level: "error", message: `${SKILLS_DIR}/${name} has no SKILL.md.`, fix: `add ${SKILLS_DIR}/${name}/SKILL.md with front matter name and description, or move the folder out` });
    } else if (!parseSkill(readFileSync(file, "utf8")).description) {
      out.push({ level: "error", message: `${SKILLS_DIR}/${name}/SKILL.md has no description in its front matter.`, fix: "add `description:`, saying when to use the skill" });
    }
  }
  return out;
}

/**
 * What vercel.json needs for the agent: the app and the agent as two services of the one project (the agent built from
 * `agent/`, its output where Vercel looks for it), /eve/v1/* routed to the agent and everything else to the app.
 */
export const SERVICES = {
  web: { root: ".", framework: "nextjs" },
  eve: {
    root: "agent", framework: "eve", outputDirectory: ".vercel/output",
    buildCommand: "cd .. && export EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY=agent/.vercel/output && export EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY=.vercel/output && node node_modules/eve/bin/eve.js build",
  },
};
export const REWRITES = [{ source: "/eve/v1/(.*)", destination: { service: "eve" } }, { source: "/(.*)", destination: { service: "web" } }];

export function vercelProblems(dir: string): CheckResult[] {
  const v = readJson(join(dir, "vercel.json")) ?? {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const ok = same(v.services?.web, SERVICES.web) && same(v.services?.eve, SERVICES.eve) && same((v.rewrites ?? []).slice(-2), REWRITES);
  return ok ? [] : [{ level: "error", message: "vercel.json does not deploy the agent beside the app.",
    fix: `give vercel.json these keys, the two rewrites last (the starter has them): ${JSON.stringify({ services: SERVICES, rewrites: REWRITES })}` }];
}

export default async function checks(ctx: CheckCtx): Promise<CheckResult[]> {
  const out = [...skillProblems(ctx.dir), ...vercelProblems(ctx.dir)];
  const pkg = readJson(join(ctx.dir, "package.json")) ?? {};
  const has = (name: string) => Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
  for (const name of ["eve", "just-bash"]) {
    if (!has(name)) out.push({ level: "error", message: `The agent plugin needs ${name}, which package.json lacks.`, fix: `npm install ${name}@${readJson(join(ctx.dir, "node_modules", "revbound", "package.json"))?.devDependencies?.[name] ?? "latest"}` });
  }
  if (!ctx.build) {
    const channels = ((ctx.options as { channels?: Channel[] })?.channels ?? ["console"]) as Channel[];
    out.push({ level: "info", message: `Agent: answers in ${channels.map((c) => (c === "console" ? "the console's Chat page" : c)).join(", ")}` });
    if (ctx.prod) {
      const names = channels.flatMap((c) => (c === "console" ? [] : CHANNEL_KEYS[c].map((k) => k.name)));
      if (names.length) out.push({ level: "info", message: `Agent: ${names.join(", ")} must be set for Production (\`npx revbound docs agent\`)` });
      out.push({ level: "info", message: "Agent: the Vercel project's Framework Preset must be Services (`npx revbound docs deploy`)" });
    }
  }
  return out;
}
