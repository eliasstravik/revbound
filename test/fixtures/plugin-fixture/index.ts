// The conformance fixture: a local plugin that adds one of everything a plugin can add.
import { definePlugin } from "revbound";

export function fixture() {
  return definePlugin({
    name: "fixture",
    api: 1,
    needs: ["database"],
    runtime: { from: "./plugins/fixture/runtime", exports: ["greet"] },
    migrations: "./plugins/fixture/migrations",
    tables: [{ schema: "gtm_fixture", name: "notes", label: "Fixture notes" }],
    routes: [{ path: "fixture/hello", methods: ["GET"], access: "session", handler: "./plugins/fixture/route" }],
    views: [{ path: "fixture", title: "Fixture", nav: { label: "Fixture", order: 60 }, component: "./plugins/fixture/view" }],
    workflowTabs: [{ id: "fixture", title: "Fixture", order: 50, component: "./plugins/fixture/tab" }],
    connections: [{ name: "FIXTURE_API_KEY", label: "Fixture" }],
    cli: [{ name: "fixture", describe: "says hello", run: "./plugins/fixture/cli" }],
    agents: "- Fixture plugin: its line in the managed block.",
    skills: ["./plugins/fixture/skills/hello"],
    docs: { fixture: "./plugins/fixture/docs.md" },
    checks: "./plugins/fixture/checks",
  });
}
