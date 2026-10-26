# Layout

A Revbound project is one Next.js app in one repo and one Vercel project per company, all three named `gtm-<company>`
(`gtm-acme`). `npx revbound init --company Acme` creates `./gtm-acme` in the current folder, writes
`gtm.config.ts` with the seven default plugins, installs, and runs `revbound sync`. Inside a Revbound project, `init` with no
folder repairs it. `init` writes the base files only: no workflows, tables or context beyond `company.md`. For demos
and tests, `init --example` also adds one small example (the `example-import` workflow, its `example_companies` table
and migration, and `context/example-icp.md`), each marked as an example.

| Path | Holds | Whose |
| --- | --- | --- |
| `gtm.config.ts` | the plugin list (`defineGtm({ company, plugins })`); read only by the CLI | company |
| `gtm/` | what `revbound sync` generates from it: `manifest.ts`, `routes.ts`, `views.tsx`, `next.ts`, `slots/<plugin>.ts`, `<plugin>.ts` binding files | sync |
| `proxy.ts`, `app/layout.tsx`, `app/[[...path]]/page.tsx`, `app/api/gtm/[...path]/route.ts` | shims that import only `gtm/` | sync |
| `AGENTS.md` | the company's instructions, plus the managed block (`<!-- BEGIN:gtm -->` … `<!-- END:gtm -->`) | company + sync |
| `CLAUDE.md` | `@AGENTS.md` | company |
| `context/` | Markdown, any shape (docs: context) | company |
| `workflows/` | Workflow SDK workflows; `workflows/index.ts` exports the registry (docs: workflows) | company |
| `webhooks/index.ts` | inbound webhooks built with `webhook()` (docs: webhooks) | company |
| `db/schema.ts`, `db/migrations/` | the company's Drizzle tables in schema `public` (docs: data) | company |
| `plugins/<name>/` | local and ejected plugins (docs: plugins) | company |
| `.agents/skills/` | the company's own skills; `<plugin>-<skill>` folders are installed by sync | company + sync |
| `.claude/skills` | symlink to `../.agents/skills`, how Claude Code sees the skills | company |
| `.env.example` | every connection name with a one-line comment (docs: connections) | company |
| `vercel.json` | crons: workflow schedules and the ledger's hourly reconcile | company |
| `next.config.ts` | `withGtm({}, { manifest, transforms, trace })`, reading `gtm/manifest.ts` and `gtm/next.ts` | company |
| `public/_gtm/probe.txt` | `gtm-probe-v1`; the fail-closed check requests it | company |
| `package.json` | scripts; `"imports"` maps `#gtm/<plugin>` to `./gtm/<plugin>.ts` (sync writes it) | company + sync |

Gitignored: `.env*.local`, `.gtm/` (local database), `.workflow-data/`, `.vercel/`, `.next/`, `node_modules/`.
`gtm/` and the shims are committed, so a deploy builds exactly what was reviewed.

## Where things go

- Company code imports plugins only through `#gtm/<plugin>`: `import { db } from "#gtm/database"`,
  `import { agent } from "#gtm/ai"`, `import { fanOut, webhook, currentRun } from "#gtm/workflows"`,
  `import { action } from "#gtm/ledger"`. Never `revbound/<plugin>` (type-only imports are fine), so a swap or an
  eject reaches every file. `revbound check` enforces it.
- Pages and API routes come only from plugins: add a local plugin in `plugins/<name>/` with `views` and `routes`
  (docs: plugins). Next file routes of the company's own (`app/api/...`, `app/<page>`) are not supported.
- A company skill is one folder, `.agents/skills/<name>/SKILL.md`, whose front matter has `name` (the folder's name)
  and `description`. Create it there, never through `.claude/skills`. A workflow stage loads it with
  `agent({ skills: ["<name>"] })`.

  ```md
  ---
  name: email-copywriting
  description: Writes cold emails in Acme's voice. Use when drafting outbound email.
  ---

  # Email copywriting

  Keep it under 90 words …
  ```
- Lasting results live in the company's tables in `public`, not in run history. The ledger keeps runs and costs.
- Reserved first path segments: `api`, `_gtm`, `_next`, `.well-known`, and every view path (`context`, `workflows`,
  `runs`, `data`, `connections` by default).

## Keeping the layout

`npx revbound check` reports what is off, each with its fix: stale generated files (`npx revbound sync`), a changed shim, a
broken registry, plugins that need a missing slot. It is read-only and runs first in every build
(`revbound check --build && revbound migrate && next build`), so a stale `gtm/` fails the build. Re-running `npx revbound init`
restores missing wiring (`public/_gtm/probe.txt`, `.gitignore`, the skills link, the registries) and syncs; it never
recreates deleted context or other files.
