/**
 * Throwaway Revbound projects for the unit tests: a temp folder whose node_modules links this repo's dependencies and the
 * repo itself as revbound (its built dist/), so jiti, sync and check resolve exactly what an install would.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
const base = process.env.REVBOUND_TEST_DIR ?? os.tmpdir();

/** The seven default plugins as revbound.config.ts imports them, plus `extra` lines and plugin entries. */
export function config({ company = "Acme", imports = "", plugins, acknowledge = "" } = {}) {
  const defaults = ["database()", "ledger({ budgets: { perRunUsd: 25, perWorkflowMonthUsd: 300, projectMonthUsd: 1000 } })",
    'workflows({ registry: "./workflows", webhooks: "./webhooks" })', "ai()", "context()", "connections()", "console()"];
  return `import { defineRevbound, definePlugin } from "revbound";
import { database } from "revbound/database";
import { ledger } from "revbound/ledger";
import { workflows } from "revbound/workflows";
import { ai } from "revbound/ai";
import { context } from "revbound/context";
import { connections } from "revbound/connections";
import { console } from "revbound/console";
${imports}
void definePlugin;
export default defineRevbound({
  company: ${JSON.stringify(company)},
  plugins: [${(plugins ?? defaults).join(", ")}],
  ${acknowledge}
});
`;
}

/** A project folder from the starter, with `files` (path → text) written over it. */
export function project(files = {}) {
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "revbound-unit-"));
  fs.cpSync(path.join(REPO, "starter"), dir, { recursive: true, verbatimSymlinks: true, filter: (src) => !src.endsWith(`${path.sep}gitignore`) });
  fs.copyFileSync(path.join(REPO, "starter", "gitignore"), path.join(dir, ".gitignore"));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.dependencies["revbound"] = "0.0.5";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const modules = path.join(dir, "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  for (const entry of fs.readdirSync(path.join(REPO, "node_modules"))) {
    if (entry === "revbound" || entry === ".bin") continue;
    fs.symlinkSync(path.join(REPO, "node_modules", entry), path.join(modules, entry));
  }
  fs.symlinkSync(REPO, path.join(modules, "revbound"));
  write(dir, { "revbound.config.ts": config(), ...files });
  // Without the agent plugin, vercel.json drops its eve service, as docs: plugins says to.
  if (!/\bagent\(/.test(read(dir, "revbound.config.ts")) && !("vercel.json" in files)) {
    const { services, rewrites, ...rest } = JSON.parse(read(dir, "vercel.json"));
    write(dir, { "vercel.json": `${JSON.stringify(rest, null, 2)}\n` });
  }
  return dir;
}

export function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

export const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
