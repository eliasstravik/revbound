/** The Context view's routes (session GET): the company's context files and skills, read from the project as deployed. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError, isHosted, json, parseSkill, SKILL_NAME, SKILLS_DIR } from "revbound/kit";

const read = (file: string) => readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), file), "utf8").catch(() => null);

/** The first heading, ignoring front matter and a closing `#` sequence. */
function heading(markdown: string): string | undefined {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return body.match(/^#{1,6} +(.+?)(?:\s+#+)?\s*$/m)?.[1];
}

/**
 * What the Context view may show: every context/**\/*.md, and under "Skills" each folder in .agents/skills that holds
 * a SKILL.md, titled by its front matter `name` (else the folder) with its `description`. AGENTS.md is not context.
 */
async function contextPaths() {
  const files = await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), "context"), { recursive: true }).catch(() => [] as string[]);
  const context = files.filter((f) => f.endsWith(".md")).map((f) => `context/${f.split(path.sep).join("/")}`).sort();
  const folders = (await readdir(path.join(/*turbopackIgnore: true*/ process.cwd(), SKILLS_DIR)).catch(() => [] as string[])).filter((f) => SKILL_NAME.test(f)).sort();
  const skills = (await Promise.all(folders.map(async (folder) => {
    const p = `${SKILLS_DIR}/${folder}/SKILL.md`, markdown = await read(p);
    const { name, description } = parseSkill(markdown ?? "");
    return markdown == null ? [] : [{ path: p, title: name ?? folder, ...(description && { description }) }];
  }))).flat();
  return { context, skills };
}

/** GET /context → { groups: [{ name: "Context" | "Skills", files: [{ path, title, description? }] }] } (missing files left out). */
export async function list(): Promise<Response> {
  const { context, skills } = await contextPaths();
  const entry = async (p: string) => {
    const markdown = await read(p);
    return markdown == null ? [] : [{ path: p, title: heading(markdown) ?? path.basename(p, ".md") }];
  };
  return json({ groups: [{ name: "Context", files: (await Promise.all(context.map(entry))).flat() }, { name: "Skills", files: skills }] });
}

/** GET /context/file?path= → { path, markdown, githubUrl }; only paths the listing returns (no traversal). */
export async function file(req: Request): Promise<Response> {
  const wanted = new URL(req.url).searchParams.get("path");
  const { context, skills } = await contextPaths();
  const markdown = wanted && [...context, ...skills.map((s) => s.path)].includes(wanted) ? await read(wanted) : null;
  if (wanted == null || markdown == null) throw new HttpError(404, "No such context file");
  const { VERCEL_GIT_PROVIDER: git, VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug, VERCEL_GIT_COMMIT_REF: ref } = process.env;
  const segments = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  const githubUrl = isHosted() && git === "github" && owner && slug && ref ? `https://github.com/${owner}/${slug}/blob/${segments(ref)}/${segments(wanted)}` : null;
  return json({ path: wanted, markdown, githubUrl });
}
