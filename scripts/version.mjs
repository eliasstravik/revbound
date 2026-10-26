#!/usr/bin/env node
/**
 * `npm run version:bump <x.y.z>`: one version across package.json and package-lock.json, the plugin manifests and
 * marketplace entries, the starter's pin and the README's Deploy button tag. It edits files only; tagging and
 * publishing stay manual.
 */
import { readFileSync, writeFileSync } from "node:fs";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? "")) {
  console.error("Usage: npm run version:bump <x.y.z>");
  process.exit(1);
}
const json = (file, edit) => {
  const data = JSON.parse(readFileSync(file, "utf8"));
  edit(data);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};
const before = JSON.parse(readFileSync("package.json", "utf8")).version;
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
