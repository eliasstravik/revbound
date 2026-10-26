import { definePlugin } from "revbound";

const P = "revbound/connections";
const SRC = "revbound/src/plugins/connections";

/**
 * Connections are environment variables. The console lists every declared name and whether it is set here, never a
 * value, and adds, edits and deletes them: locally in .env.local, hosted in Vercel's Production env (REVBOUND_VERCEL_TOKEN).
 */
export function connections() {
  return definePlugin({
    name: "connections",
    api: 1,
    uses: ["workflows"],
    routes: [
      { path: "connections", methods: ["GET"], access: "session", handler: `${P}/routes#list` },
      { path: "connections/change", methods: ["POST"], access: "console", handler: `${P}/routes#change` },
      { path: "connections/missing", methods: ["GET"], access: "session", handler: `${P}/routes#missing` },
    ],
    views: [{ path: "connections", title: "Connections", nav: { label: "Connections", order: 50, count: "connections/missing" }, component: `${P}/view` }],
    workflowTabs: [{ id: "connections", title: "Connections", order: 40, component: `${P}/tab` }],
    cli: [{ name: "connections", describe: "list, set or delete local keys in .env.local (values from a hidden prompt or stdin)", run: `${P}/cli` }],
    agents: `- \`.env.example\`: every connection name, with a one-line comment above it. Never ask for a key's value in chat: the person adds it on the
  console's Connections page (locally and on the production domain), or with \`npx revbound connections set <NAME>\` (a hidden prompt) locally.`,
    docs: { connections: `${SRC}/docs/connections.md` },
  });
}
