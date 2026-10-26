import { definePlugin } from "revbound";

const P = "revbound/database";
const SRC = "revbound/src/plugins/database";

/**
 * The `database` slot: db() over pg (PGlite locally, served by revbound dev when DATABASE_URL is unset), migrations for every
 * plugin and the company, the production stamp, the Data view and the local "Open database".
 */
export function database() {
  return definePlugin({
    name: "database",
    api: 1,
    provides: ["database"],
    provide: `${P}/provide`,
    schema: "revbound",
    runtime: { from: `${P}/runtime`, exports: ["db"] },
    migrations: `${SRC}/migrations`,
    routes: [
      { path: "data", methods: ["GET"], access: "session", handler: `${P}/data#tables` },
      { path: "data/:table", methods: ["GET"], access: "session", handler: `${P}/data#page` },
      { path: "data/:table/:format", methods: ["GET"], access: "session", handler: `${P}/data#exported` },
      { path: "database", methods: ["GET"], access: "session", handler: `${P}/studio#destination` },
      { path: "database/open", methods: ["POST"], access: "tailnet", handler: `${P}/studio#open` },
    ],
    views: [{ path: "data", title: "Data", nav: { label: "Data", order: 40 }, component: `${P}/view` }],
    workflowTabs: [{ id: "data", title: "Data", order: 30, component: `${P}/tab` }],
    cli: [{ name: "migrate", describe: "apply database migrations (the plugins', then db/migrations)", run: `${P}/cli` }],
    agents: `- \`db/schema.ts\`: the company's Drizzle tables, schema \`public\` (plugins keep their own schemas). After a change:
  \`npm run db:generate\`, then \`npx revbound migrate\`. Use \`db()\` from \`#revbound/database\` inside \`"use step"\` functions only
  (docs: data).`,
    docs: { data: `${SRC}/docs/data.md` },
    checks: `${P}/checks`,
    dev: `${P}/dev`,
  });
}
