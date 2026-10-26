# Data

## `db()`

`import { db } from "#gtm/database"` gives Drizzle over a `pg` pool on `DATABASE_URL`, one pool per process (at most 3
connections locally).

- Locally with no `DATABASE_URL`, `npm run dev` serves the project's own PGlite database on 127.0.0.1 and passes
  its URL to the app. Hosted, `DATABASE_URL` is required and `db()` fails loudly without it.
- Call it inside `"use step"` bodies and route handlers only; in workflow code itself it throws, and it throws
  during `next build`.

## Tables and migrations

- The company's tables live in `public`, defined in `db/schema.ts`. After a schema change run `npm run db:generate`,
  then `npx revbound migrate`, even while `npm run dev` runs; `dev` applies pending migrations only when it starts.
- `revbound migrate` applies every plugin's migrations in `needs` order (`database`, `ledger`, `workflows`, then the rest),
  each set bookkept in its own schema's `__gtm_migrations`, then the company's `db/migrations/` with Drizzle's own
  bookkeeping, under one advisory lock.
- Plugin schemas (`gtm`, `gtm_ledger`, `gtm_workflows`, `gtm_<plugin>`) are the plugins': never create, change or drop
  anything in them. Company tables never go there.
- `npm run build` runs `revbound migrate` first, so a production deploy migrates production. Preview migrates only
  when Preview has its own `DATABASE_URL` that is not production's; otherwise it skips with a notice.

## Migrations only add

A migration containing `DROP`, `RENAME`, `TRUNCATE`, `ALTER … TYPE` or `DELETE` is destructive. A hosted production
`revbound migrate` refuses it unless gtm.config.ts lists it by exact id in `acknowledge.destructive`: `"company:0012"` for
`db/migrations/0012_…sql`, `"<plugin>:<NNNN>"` for a plugin's. Add that only after a yes in chat and a Neon backup
branch of production made before it deploys. A Vercel rollback restores code, not the schema.

## The production stamp

A hosted production `revbound migrate` writes `gtm.meta` key `production` = the database identity: for Neon the
endpoint id (host with `-pooler` removed, so pooled and unpooled URLs match), else the host. Neon preview and
dev branches copy the stamp but have other endpoint ids, so they work.

`db()`, `revbound migrate` and `revbound dev` refuse a database whose stamp names its own identity anywhere but hosted
production, even with `VERCEL_ENV=production` in `.env.local`, with "This is production's database; connect a
dev branch instead". It means `DATABASE_URL` here is production's. Remove it from `.env.local` to use the
local database, or connect a Neon dev branch to Development and `vercel env pull` again (docs: local).

## Local data

- PGlite data lives in `.gtm/pglite/`; `.gtm/db.lock` names the serving process and port. Other Revbound commands
  use the running server; with none running they start a short-lived one.
- Query it with any Postgres client through the URL `npx revbound check` prints while `npm run dev`
  runs (`postgres://postgres:postgres@127.0.0.1:<port>/postgres?sslmode=disable`; the port changes per start).
  `sslmode` must be `disable` (or omitted); user and password are ignored; at most 10 connections, of which
  the app's pool uses 3.
- All local connections share ONE Postgres session: a `SET` on one is seen by all, named prepared statements
  collide (Drizzle and `pg` use unnamed ones unless you call `.prepare(name)`), and an open transaction makes
  every other client wait until it ends. Keep transactions short and never leave one idle.
- PGlite is not full Postgres. When something fails only locally, point `DATABASE_URL` at a Neon dev branch.
- A data folder written by another PGlite major version makes `revbound dev` refuse and print the dump and restore
  commands.
- Local data is development data and never moves to production.

## The Data view

Read-only: the company's tables in `public`, then the tables and views plugins declare (the ledger's runs, actions,
cost per run and spend by month), one at a time as a scrolling grid (rows are read as they scroll into view),
with search, a one-column filter, sorting, a column chooser, and CSV or JSON export of what is shown (capped at
10,000 rows / 5 MB with a "truncated" notice; in CSV, text starting with `=`, `+`, `-`, `@`, a tab or a carriage
return gets a leading `'` so spreadsheets show it instead of running it). A column named `name`, `title` or ending in `_name`/`_title` stays
pinned on the left; columns ending in `score`, `verdict`, `priority`, `tier`, `fit`, `grade` or `rating` come right
after it. It runs no SQL from the browser.

## Open database

The Data toolbar's "Open database" (in its ⋯ menu, with Export, when the window is narrow) goes to a full editor; the
Data view is a preview. It shows on a project with no tables too.

- Locally it starts Drizzle Studio for the database the app uses (the local PGlite one or `DATABASE_URL`), with
  the project's own `drizzle-kit` and `drizzle.config.ts`, on 127.0.0.1 and the first free port from 4983, and
  opens `https://local.drizzle.studio/?port=<port>` (Chrome may ask to allow local network access). One Studio
  per `npm run dev`, reused; it stops with it. A production-stamped database is refused. Studio's connection is
  one of the 10 and shares the one session.
- Pressed on this machine's Tailscale name (`GTM_ALLOWED_HOSTS`, through `tailscale serve`), Studio is shared
  with that same Tailscale login only: Tailscale Serve on the first free HTTPS port from 8443 (never Funnel), in
  front of a loopback gate that admits only that login. One login per `npm run dev`; it removes the share when it
  stops. On other allowed hosts, and to devices without a Tailscale login, the button does not show.
- Hosted it links to the Neon console when `NEON_PROJECT_ID` is set, else to the Vercel project's Storage tab
  (Storage → Open in Neon).
