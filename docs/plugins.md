# Plugins

Everything in a Revbound project is a plugin listed in `revbound.config.ts`. There is no runtime plugin kernel: plugins
are plain data whose code fields are module specifiers, and `revbound sync` turns the list into committed files under
`_revbound/` that the app imports. The fixed core is wiring only: sync, `revbound check`, the access check and the CLI
shell.

## The defaults

`revbound init` writes eight, each a subpath of this package:

| Plugin | Provides / needs | What it does |
| --- | --- | --- |
| `database` | provides `database` | `db()`, PGlite locally, migrations, the production stamp, Data, Open database |
| `ledger` | provides `ledger`; needs `database`; uses `workflows` | runs, costs and approvals; admit, reserve and settle; reconcile; Runs |
| `workflows` | provides `workflows`; needs `database`, `ledger` | the registry, the one start path, `fanOut`, `webhook`, `currentRun`, crons, `revbound run`, Workflows |
| `ai` | needs `workflows`, `ledger`; spends | `agent()` on AI Gateway, provider keys or the local `claude`/`codex` |
| `context` | none | the Context view (the console's home) and the context rules |
| `connections` | none | the Connections view, `revbound connections` |
| `console` | none | the console's frame, its page, its 404 |
| `agent` | needs `workflows`, `ledger` | the project's chat agent (eve): the console's Chat page, chat apps such as Slack, `revbound agent` (docs: agent) |

Delete a line to remove a plugin, then run `npx revbound sync`; `npx revbound check` names any plugin that still needs
it. The smallest working set is `database`, `ledger` and `workflows`. Without `console`, sync writes a plain layout and
a `notFound()` page. Without `context`, `agent({ skills })` still reads `.agents/skills`. Without `agent`, sync removes
`agent/` and the console has no Chat page; also remove `services` and `rewrites` from `vercel.json`.

## Optional plugins

These ship in the package too, but no project gets them until it adds one with `npx revbound add <name>`:

| Plugin | Provides / needs | What it does |
| --- | --- | --- |
| `mdm` | provides `mdm`; needs `database`, the ledger; uses `workflows`; writes people | one de-duplicated set of people, companies and signals, where each field came from, `#revbound/mdm`, People, Companies, Signals (docs: mdm) |

## Adding and changing plugins

```sh
npx revbound add <name>                                           # an optional plugin above: prints the lines to add
npx revbound add <npm package[@version] | git url#<commit sha>>   # installs it pinned, prints the lines to add
npx revbound remove <name>                                        # prints the lines to delete; never drops tables
npx revbound eject <name>                                         # copies a default plugin into plugins/<name> to edit it
npx revbound diff <name>                                          # what changed upstream since the eject
```

`add` and `remove` never edit `revbound.config.ts`; `eject` only flips that plugin's import to `./plugins/<name>` and
syncs. It keeps a pristine copy and the version in `plugins/<name>/.revbound-eject/`; your own edits are
`git diff --no-index plugins/<name>/.revbound-eject/src plugins/<name>`. An ejected or custom `ledger` needs
`acknowledge: { customLedger: true }` and stops getting the package's safety fixes.

## Writing a plugin

A plugin is `definePlugin({ name, api: 1, … })` in `plugins/<name>/index.ts` (local) or a package. Code fields are
module specifiers: project paths (`./plugins/<name>/route`) for local plugins, package subpaths for packages; the
default export is the value, `#name` names another export.

```ts
import { definePlugin } from "revbound";

export function notes() {
  return definePlugin({
    name: "notes",
    api: 1,
    needs: ["database"],
    migrations: "./plugins/notes/migrations",          // NNNN_name.sql, in schema revbound_notes
    tables: [{ schema: "revbound_notes", name: "notes", label: "Notes" }],
    routes: [{ path: "notes", methods: ["GET"], access: "session", handler: "./plugins/notes/route" }],
    views: [{ path: "notes", title: "Notes", nav: { label: "Notes", order: 60 }, component: "./plugins/notes/view" }],
    runtime: { from: "./plugins/notes/runtime", exports: ["note"] },
    agents: "- Notes: …",
  });
}
```

| Field | What it adds |
| --- | --- |
| `provides`, `provide` | a slot (`database`, `ledger`, `workflows` or your own) and its implementation `(ctx) => Slot` |
| `needs`, `uses` | slots it requires (and migration order), slots it calls only when present |
| `capabilities` | `spends`, `sends`, `writesPeople`; any of them requires the ledger |
| `runtime` | helpers company code imports as `#revbound/<name>`: `from` exports `bind(rt)` and a type `Api`; `step` exports `run(manifest, map, op, args)`, reached only inside generated steps |
| `schema`, `migrations`, `tables` | its own Postgres schema (default `revbound_<name>`), its SQL migrations, tables or views shown in Data |
| `routes` | under `/api/revbound/`, each with an access mode (below) |
| `views`, `workflowTabs` | console pages (with an optional nav item) and tabs on a workflow's page |
| `connections` | environment variable names it reads, with labels |
| `cli` | `revbound <name>` commands; `run` default-exports `(args, ctx) => Promise<void>` |
| `agents`, `skills`, `docs` | an AGENTS.md line, skill folders installed as `.agents/skills/<plugin>-<skill>`, `revbound docs` topics |
| `files` | project files it owns, which sync writes and removes (path → contents, or `{ link }`); never `_revbound/`, the shims or `.agents/` |
| `checks` | `(ctx) => Promise<CheckResult[]>`, run by `revbound check` |
| `trace`, `next`, `dev` | files the build must ship, a Next.js config transform, a `revbound dev` hook |
| `modules`, `options` | project modules its code reads with `ctx.module(name)`, plain JSON options |

Route handlers default-export `(req, ctx) => Response`; `ctx` has `params`, `manifest`, `options`, `get(slot)`,
`has(slot)` and `module(name)`. Views default-export a client component that gets `{ params, manifest, tabs }`; tabs
get `{ workflow, manifest }`. Shared pieces come from `revbound/ui` (`useApi`, `Link`, `Status`, …) and
`revbound/kit`.

### Access modes

| Mode | Hosted | Local |
| --- | --- | --- |
| `session` (GET only) | Vercel Authentication; any bypass credential is refused | loopback or a `REVBOUND_ALLOWED_HOSTS` host |
| `console` | reads: as `session`; writes: Vercel Authentication, no bypass credential, from the console's own page (same origin) | reads: as `session`; writes: same-origin, from loopback or a Tailscale login on an allowed host (as `tailnet`) |
| `automation` | the automation bypass secret, in the header | loopback, same-origin |
| `cron` | `Authorization: Bearer $CRON_SECRET`; refused when unset | the same |
| `signature` | the sender's own bypass secret (`secret`: its variable, e.g. `REVBOUND_HOOK_{name}_BYPASS`), never the automation one; the handler is built with `webhook()` | loopback |
| `local` | refused | loopback only, never an allowed host |
| `tailnet` | refused | loopback, or a same-origin request on a `REVBOUND_ALLOWED_HOSTS` host that Tailscale Serve marks with a login (never Funnel) |

An `/api/*` path no plugin declares is refused, and pages always get the session rule.

### Slots and binding files

Cross-plugin behavior goes only through slots: `ctx.get("ledger").reserve(…)`, never an import of another plugin's code
(type imports are fine). The slot interfaces are `DatabaseSlotV1`, `LedgerSlotV1` and `WorkflowsSlotV1`, from
`revbound`; an optional plugin's comes with it (`MdmSlotV1` from `revbound/mdm`). A replacement for a default keeps its
`name` and at least its `runtime.exports`; a slot plugin can be swapped for any plugin that provides the same slot
interface.

For a plugin with `runtime`, sync writes `_revbound/<name>.ts`: workflow-safe wrappers around `bind(rt)`, plus generated
`"use step"` functions that dynamic-import the plugin's step module and its slot map. Generated files make no
top-level calls, so nothing heavy reaches workflow code except inside a step. `package.json` `"imports"` maps
`#revbound/<name>` to it and `tsconfig.json` mirrors it.

## The entry rule for the defaults

A plugin joins the default list only when most new companies would use it in week one; it works under `revbound dev`
with no new account; the base holds a vendor-neutral slot, never a named vendor; it owns its schema, declares its routes
with access rules, depends only on slot interfaces and binding files, and removing it fails `revbound check` with a
clear needs error; every send, spend and write about people goes through the ledger; it shipped as an optional plugin
for a minor release and passes the acceptance tests; it supplies state, durable execution, credentials, records or
limits, not a workaround for today's models; and maintainers accept the upkeep within its line budget. An addition
changes only what `init` writes; existing projects opt in with `revbound add`. A removal never uninstalls anything.
