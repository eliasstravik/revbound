# Layout

A Revbound project is one Next.js app in one repo and one Vercel project per company, all three named
`revbound-<company>` (`revbound-acme`). `npx revbound init --company Acme` creates `./revbound-acme` in the current
folder, writes `revbound.config.ts` with the eight default plugins, installs, and runs `revbound sync`. Inside a
Revbound project, `init` with no folder repairs it. `init` writes the base files only: no workflows, tables or context
beyond `company.md`. For demos and tests, `init --example` also adds one small example (the `example-import` workflow,
its `example_companies` table and migration, and `context/example-icp.md`), each marked as an example.

| Path | Holds | Whose |
| --- | --- | --- |
| `revbound.config.ts` | the plugin list (`defineRevbound({ company, plugins })`); read only by the CLI | company |
| `_revbound/` | what `revbound sync` generates from it: `manifest.ts`, `routes.ts`, `views.tsx`, `next.ts`, `slots/<plugin>.ts`, `<plugin>.ts` binding files | sync |
| `proxy.ts`, `app/layout.tsx`, `app/[[...path]]/page.tsx`, `app/api/revbound/[...path]/route.ts` | shims that import only `_revbound/` | sync |
| `agent/` | the chat agent's eve folder (docs: agent); `agent/skills` links to `.agents/skills` | sync |
| `AGENTS.md` | the company's instructions, plus the managed block (`<!-- BEGIN:revbound -->` … `<!-- END:revbound -->`) | company + sync |
| `CLAUDE.md` | `@AGENTS.md` | company |
| `context/` | Markdown, any shape (docs: context) | company |
| `workflows/` | Workflow SDK workflows; `workflows/index.ts` exports the registry (docs: workflows) | company |
| `webhooks/index.ts` | inbound webhooks built with `webhook()` (docs: webhooks) | company |
| `db/schema.ts`, `db/migrations/` | the company's Drizzle tables in schema `public` (docs: data) | company |
| `plugins/<name>/` | local and ejected plugins (docs: plugins) | company |
| `.agents/skills/` | the company's own skills, one folder each and nothing else (the chat agent loads every entry as a skill); `<plugin>-<skill>` folders are installed by sync | company + sync |
| `.claude/skills` | symlink to `../.agents/skills`, how Claude Code sees the skills | company |
| `.env.example` | every connection name with a one-line comment (docs: connections) | company |
| `vercel.json` | crons: workflow schedules and the ledger's hourly reconcile; the app and the chat agent as two services | company |
| `next.config.ts` | `withRevbound({}, { manifest, transforms, trace })`, reading `_revbound/manifest.ts` and `_revbound/next.ts` | company |
| `public/_revbound/probe.txt` | `revbound-probe-v1`; the fail-closed check requests it | company |
| `package.json` | scripts; `"imports"` maps `#revbound/<plugin>` to `./_revbound/<plugin>.ts` (sync writes it) | company + sync |

Gitignored: `.env*.local`, `.revbound/` (local database), `.workflow-data/`, `.eve/` and `.output/` (the agent's local
state and build), `.vercel/`, `.next/`, `node_modules/`.
`_revbound/` and the shims are committed, so a deploy builds exactly what was reviewed.

## Where things go

- Company code imports plugins only through `#revbound/<plugin>`: `import { db } from "#revbound/database"`,
  `import { agent } from "#revbound/ai"`, `import { fanOut, webhook, currentRun } from "#revbound/workflows"`,
  `import { action } from "#revbound/ledger"`. Never `revbound/<plugin>` (type-only imports are fine), so a swap or an
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
- Reserved first path segments: `api`, `_revbound`, `_next`, `.well-known`, `eve`, and every view path (`chat`,
  `context`, `workflows`, `runs`, `data`, `connections` by default).

## Keeping the layout

`npx revbound check` reports what is off, each with its fix: stale generated files (`npx revbound sync`), a changed
shim, a broken registry, plugins that need a missing slot. It is read-only and runs first in every build
(`revbound check --build && revbound migrate && next build`), so a stale `_revbound/` fails the build. Re-running
`npx revbound init` restores missing wiring (`public/_revbound/probe.txt`, `.gitignore`, the skills link, the
registries) and syncs; it never recreates deleted context or other files.
