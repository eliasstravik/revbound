#!/usr/bin/env node
/**
 * `npm run version:bump <x.y.z>`: one version across package.json and package-lock.json, the plugin manifests and
 * marketplace entries, the starter's pin and the README's Deploy button tag. It edits files only; tagging and
 * publishing stay manual. A release moves the patch by one (0.0.7 → 0.0.8, or 0.0.8-rc.1 on the way); anything else
 * needs `--allow-bump`, which only the human asks for.
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
// Without `--`, npm keeps the flag for itself and hands it over as npm_config_allow_bump.
const allowBump = args.includes("--allow-bump") || process.env.npm_config_allow_bump === "true";
const next = args.find((a) => !a.startsWith("--"));
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? "")) {
  console.error("Usage: npm run version:bump -- <x.y.z> [--allow-bump]");
  process.exit(1);
}
const json = (file, edit) => {
  const data = JSON.parse(readFileSync(file, "utf8"));
  edit(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const before = JSON.parse(readFileSync("package.json", "utf8")).version;
// The next patch, or the release of a pre-release (0.0.8-rc.1 → 0.0.8); its own pre-releases count too.
const [core, pre] = before.split("-");
const [major, minor, patch] = core.split(".").map(Number);
const expected = pre ? core : `${major}.${minor}.${patch + 1}`;
if (!allowBump && (next.split("-")[0] !== expected || next === before)) {
  console.error(`Expected ${expected} (or ${expected}-rc.N): a release bumps only the patch by one. ` +
    "Pass --allow-bump only when the human asked for another version.");
  process.exit(1);
}
json("package.json", (p) => { p.version = next; });
json("package-lock.json", (p) => { p.version = next; p.packages[""].version = next; });
json("plugin.json", (p) => { p.version = next; });
json(".claude-plugin/plugin.json", (p) => { p.version = next; });
json(".cursor-plugin/plugin.json", (p) => { p.version = next; });
json(".github/plugin/marketplace.json", (p) => { for (const entry of p.plugins) entry.version = next; });
// The starter keeps its range prefix (^0.0.5 → ^0.0.6).
json("starter/package.json", (p) => {
  const deps = p.dependencies;
  deps["revbound"] = `${/^[\^~]?/.exec(deps["revbound"])[0]}${next}`;
});
const readme = readFileSync("README.md", "utf8");
writeFileSync("README.md", readme.replaceAll(`tree%2Fv${before}%2F`, `tree%2Fv${next}%2F`).replaceAll(`at \`v${before}\``, `at \`v${next}\``));
console.log(`Version ${before} → ${next} in package.json, package-lock.json, the plugin manifests, starter/package.json and README.md.`);
