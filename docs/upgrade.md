# Upgrade

## From @eliasstravik/gtm 0.0.5

The package is now `revbound`, and so is the command: `gtm` is gone. In the project:

1. `npm uninstall @eliasstravik/gtm && npm install revbound@0.0.6`
2. In every file, change imports from `@eliasstravik/gtm` to `revbound` (`@eliasstravik/gtm/kit` → `revbound/kit`, and
   so on).
3. In `package.json`'s scripts, change `gtm` to `revbound` (the build script is
   `revbound check --build && revbound migrate && next build`).
4. `npx revbound sync`, then `npx revbound check`, and commit.

Nothing else changes: `gtm.config.ts`, the `GTM_*` variables, the database schemas and the routes keep their names.

## From 0.0.4 or earlier

The plugin layout replaces the old wiring, and there is no automatic migration. Make a new project and copy the
company's files across:

1. `npx revbound init --company <Company>` in a new folder (it makes `./gtm-<company>`).
2. Copy from the old project: `context/`, `.agents/skills/`, `workflows/`, `db/` (schema and migrations), and the
   names in `.env.example`. Copy `.env.local` too, or set the keys again with `npx revbound connections set`.
3. In `workflows/`, change the imports:
   - `@eliasstravik/gtm/db` → `#gtm/database`
   - `@eliasstravik/gtm/ai` → `#gtm/ai`
   - `import type { Registry } from "@eliasstravik/gtm/api"` → `from "revbound"`
4. Mark the workflows that spend money or act on people `approval: { required: true }`, and give scheduled ones
   `budget: { perRunUsd, perMonthUsd }` and a `schedule: { approvedUntil, note }` after a yes (docs: ledger).
5. Inbound webhooks move from `app/api/hooks/<sender>/route.ts` to `webhooks/index.ts` with `webhook()` (docs:
   webhooks).
6. `npx revbound check`, then `npm run dev` and `npx revbound run <workflow> --preview`.
7. Deploy: point the existing Vercel project at the new repo, or create one and move the Neon integration. The new
   `vercel.json` schedules the hourly reconcile, which needs `CRON_SECRET` (docs: deploy). The Slack agent
   and the console's key form are gone: set production keys with `vercel env add` (docs: connections).

The old `gtm.__drizzle_migrations` table stays in the old database; the new one keeps its bookkeeping in each plugin's
schema (`gtm.__gtm_migrations`, `gtm_ledger.__gtm_migrations`, …) and the company's in `drizzle`.

## Between versions

Update the package (`npm install revbound@<version>`), then `npx revbound sync` and commit what it changed. A
build fails until then: `revbound check --build` sees the generated files are stale.
