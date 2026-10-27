#!/usr/bin/env node
/** `npm run lines`: TS/TSX lines per plugin and for the core, against the budgets in each plugin's README. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BUDGETS = { database: 1350, ledger: 750, workflows: 900, ai: 900, context: 280, connections: 750, console: 500, mdm: 850, agent: 2350, core: 1900 };
const count = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }) : [])
  .filter((f) => /\.tsx?$/.test(f) && statSync(join(dir, f)).isFile()).reduce((n, f) => n + readFileSync(join(dir, f), "utf8").split("\n").length, 0);
const rows = Object.keys(BUDGETS).map((name) => {
  const lines = name === "core" ? count("src/core") + count("src/kit") + ["src/index.ts", "src/cli-kit.ts"].reduce((n, f) => n + readFileSync(f, "utf8").split("\n").length, 0)
    : count(join("src/plugins", name)) + (name === "console" ? count("src/ui") : 0);
  return { name, lines, budget: BUDGETS[name] };
});
for (const r of rows) console.log(`${r.name.padEnd(12)} ${String(r.lines).padStart(5)} / ${String(r.budget).padStart(5)}${r.lines > r.budget ? `  over by ${r.lines - r.budget}` : ""}`);
