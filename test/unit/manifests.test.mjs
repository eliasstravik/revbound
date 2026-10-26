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

// A copy of the files version:bump edits, at version `at` when given; run(...args) bumps it and throws on a refusal.
const bumpCopy = (at) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revbound-bump-"));
  for (const rel of ["package.json", "package-lock.json", "starter/package.json", "README.md", ...manifests, ...marketplaces]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
  }
  if (at) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...json("package.json", dir), version: at }));
  const run = (...args) => execFileSync(process.execPath, [path.join(root, "scripts/version.mjs"), ...args], {
    cwd: dir, stdio: "pipe", env: { ...process.env, npm_config_allow_bump: "" },
  });
  return { dir, run, version: () => json("package.json", dir).version };
};

test("npm run version:bump moves every manifest", () => {
  const { dir, run } = bumpCopy();
  try {
    run("9.9.9", "--allow-bump");
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

test("npm run version:bump takes only the next patch unless --allow-bump", () => {
  const refuses = (from, to, expected) => {
    const { dir, run, version } = bumpCopy(from);
    try {
      const named = (e) => String(e.stderr).includes(`Expected ${expected} `) && String(e.stderr).includes("--allow-bump");
      assert.throws(() => run(to), named, `${from} → ${to}`);
      assert.equal(version(), from, `${from} → ${to} left the files alone`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const takes = (from, ...args) => {
    const { dir, run, version } = bumpCopy(from);
    try {
      run(...args);
      assert.equal(version(), args[0], `${from} → ${args[0]}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  for (const to of ["0.0.7", "0.0.9", "0.1.0", "1.0.0", "0.0.6", "0.1.0-rc.1"]) refuses("0.0.7", to, "0.0.8");
  refuses("0.0.8-rc.1", "0.0.9", "0.0.8");
  takes("0.0.7", "0.0.8");
  takes("0.0.7", "0.0.8-rc.1");
  takes("0.0.8-rc.1", "0.0.8-rc.2");
  takes("0.0.8-rc.1", "0.0.8");
  takes("0.0.7", "0.1.0", "--allow-bump");
  takes("0.0.7", "1.0.0", "--allow-bump");
  const { dir, version } = bumpCopy("0.0.7");
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/version.mjs"), "0.1.0"], {
      cwd: dir, stdio: "pipe", env: { ...process.env, npm_config_allow_bump: "true" },
    });
    assert.equal(version(), "0.1.0", "the flag also arrives through npm without --");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
