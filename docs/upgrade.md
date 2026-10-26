# Upgrade

## From revbound 0.0.6

Every remaining `gtm` name is now `revbound`, with no fallback: an old project fails `revbound check` and its build
until it is renamed. In the project:

1. `npm install revbound@<version>`.
2. Rename `gtm.config.ts` to `revbound.config.ts` and, in it, `defineGtm` to `defineRevbound`. In `next.config.ts`,
   `withGtm` becomes `withRevbound` and `./gtm/` becomes `./_revbound/`.
3. Delete the generated `gtm/` folder (sync now writes `_revbound/`) and `app/api/gtm/`, and the managed block in
   `AGENTS.md` (from `<!-- BEGIN:gtm -->` to `<!-- END:gtm -->`). Rename `public/_gtm/` to `public/_revbound/`.
4. In company code, imports from `#gtm/<plugin>` become `#revbound/<plugin>`, and `GtmPlugin`, `GtmConfig` and the
   other `Gtm` types become `RevboundPlugin`, `RevboundConfig` and so on. Routes move from `/api/gtm/` to
   `/api/revbound/`: change the paths in `vercel.json`'s crons and in every webhook sender.
5. Rename every `GTM_*` variable to `REVBOUND_*` (`GTM_MODEL` → `REVBOUND_MODEL`, `GTM_HOOK_<NAME>_BYPASS` →
   `REVBOUND_HOOK_<NAME>_BYPASS`, …) in `.env.example`, `.env.local` and the Vercel project's env.
6. In `.gitignore`, `.gtm/` becomes `.revbound/`; move the local database folder `.gtm/` to `.revbound/` (stop
   `npm run dev` first). An ejected plugin's `plugins/<name>/.gtm-eject/` becomes `.revbound-eject/`.
7. Rename the database schemas, in production and in any other database the project uses:

   ```sql
   alter schema gtm rename to revbound;
   alter table revbound.__gtm_migrations rename to __revbound_migrations;
   alter schema gtm_ledger rename to revbound_ledger;
   alter table revbound_ledger.__gtm_migrations rename to __revbound_migrations;
   alter schema gtm_workflows rename to revbound_workflows;
   alter table revbound_workflows.__gtm_migrations rename to __revbound_migrations;
   -- and the same two lines for gtm_mdm and every other gtm_<plugin> schema
   ```

8. `npx revbound sync`, then `npx revbound check`, and commit.

## From @eliasstravik/gtm 0.0.5

The package is now `revbound`, and so is the command: `gtm` is gone. Upgrade to 0.0.6 first, then follow the steps
above. In the project:

1. `npm uninstall @eliasstravik/gtm && npm install revbound@0.0.6`
2. In every file, change imports from `@eliasstravik/gtm` to `revbound` (`@eliasstravik/gtm/kit` → `revbound/kit`, and
   so on).
3. In `package.json`'s scripts, change `gtm` to `revbound` (the build script is
   `revbound check --build && revbound migrate && next build`).
4. `npx revbound sync`, then `npx revbound check`, and commit.

## From 0.0.4 or earlier

The plugin layout replaces the old wiring, and there is no automatic migration. Make a new project and copy the
company's files across:

1. `npx revbound init --company <Company>` in a new folder (it makes `./revbound-<company>`).
2. Copy from the old project: `context/`, `.agents/skills/`, `workflows/`, `db/` (schema and migrations), and the
   names in `.env.example`. Copy `.env.local` too, or set the keys again with `npx revbound connections set`.
3. In `workflows/`, change the imports:
   - `@eliasstravik/gtm/db` → `#revbound/database`
   - `@eliasstravik/gtm/ai` → `#revbound/ai`
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
schema (`revbound.__revbound_migrations`, `revbound_ledger.__revbound_migrations`, …) and the company's in `drizzle`.

## Between versions

Update the package (`npm install revbound@<version>`), then `npx revbound sync` and commit what it changed. A
build fails until then: `revbound check --build` sees the generated files are stale.
