/** Every plugin manifest and marketplace listing parses, ships only skills/revbound and carries the package's version. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = (rel, dir = root) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
const { version } = json("package.json");

// Agent Plugins (npx plugins add, Codex, Copilot CLI), Claude Code, Cursor.
const manifests = ["plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"];
// Claude Code, Codex, Copilot CLI.
const marketplaces = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", ".github/plugin/marketplace.json"];
const sourcePath = (entry) => (typeof entry.source === "string" ? entry.source : entry.source.path);

test("every plugin manifest is revbound at the package's version", () => {
  for (const file of manifests) {
    const m = json(file);
    assert.equal(m.name, "revbound", file);
    assert.equal(m.version, version, file);
  }
});

test("every marketplace lists revbound once, from the repo root, at the package's version where it names one", () => {
  for (const file of marketplaces) {
    const m = json(file);
    assert.equal(m.name, "eliasstravik", file);
    assert.deepEqual(m.plugins.map((p) => p.name), ["revbound"], file);
    const [entry] = m.plugins;
    assert.equal(path.resolve(root, sourcePath(entry)), path.resolve(root), file);
    if ("version" in entry) assert.equal(entry.version, version, file);
  }
  const codex = json(".agents/plugins/marketplace.json").plugins[0];
  assert.ok(codex.policy?.installation && codex.policy?.authentication && codex.category, "Codex entries need policy and category");
});

test("the plugin ships the revbound skill and nothing else a host would load", () => {
  assert.deepEqual(fs.readdirSync(path.join(root, "skills")), ["revbound"]);
  assert.ok(fs.existsSync(path.join(root, "skills/revbound/SKILL.md")));
  for (const extra of ["agents", "commands", "rules", "hooks", "mcp.json", ".mcp.json", ".app.json", ".codex-plugin", "com.github.copilot"]) {
    assert.ok(!fs.existsSync(path.join(root, extra)), `${extra} would add to the plugin`);
  }
});

test("npm run version:bump moves every manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revbound-bump-"));
  try {
    for (const rel of ["package.json", "package-lock.json", "starter/package.json", "README.md", ...manifests, ...marketplaces]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
    }
    execFileSync(process.execPath, [path.join(root, "scripts/version.mjs"), "9.9.9"], { cwd: dir, stdio: "pipe" });
    for (const file of manifests) assert.equal(json(file, dir).version, "9.9.9", file);
    for (const file of marketplaces) {
      for (const entry of json(file, dir).plugins) if ("version" in entry) assert.equal(entry.version, "9.9.9", file);
    }
    const pin = json("starter/package.json").dependencies["revbound"].replace(/[\d.]+.*$/, "");
    assert.equal(json("starter/package.json", dir).dependencies["revbound"], `${pin}9.9.9`, "the starter keeps its range");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
