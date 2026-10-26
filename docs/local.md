# Local

## Zero sign-ups

`npm run dev` (`npx revbound dev`) needs no account: it runs `revbound sync`, serves the project's own PGlite database
on 127.0.0.1 (docs: data), applies pending migrations, starts the ledger's one-minute reconcile, and runs `next dev`
with the Workflow SDK's local world. It re-syncs when `revbound.config.ts`, `.env.example` or a local plugin changes. AI
steps run on your own `claude` or `codex` login (docs: ai). The console is `http://127.0.0.1:$REVBOUND_PORT/` (default
3000), with no login. Anything under `revbound dev` or `next dev` is never "hosted", whatever the env files say; the CLI
loads env files exactly as Next does. Local data is development data and never moves to production.

## Switching to real services

Environment variables alone switch services. After `vercel link`, `vercel env pull` writes the Development
environment into `.env.local`; it keeps local-only entries, and a Secret value it cannot read arrives as
Vercel's placeholder, which Revbound treats as missing (set it again with `npx revbound connections set`).

- Connect only a Neon dev branch to Development; a pulled `DATABASE_URL` replaces the local database.
- A pulled `VERCEL_OIDC_TOKEN` switches laptop `agent()` calls to AI Gateway (path 1), which bills the team (docs: ai).
  `vercel link` alone already writes one into `.env.local`; delete that line to stay on `claude`/`codex`.
- Never pull production's env to a laptop (`--environment=production`); production's stamped database is
  refused anyway (docs: data). Remove `DATABASE_URL` from `.env.local` to go back to the local database.

## `REVBOUND_ALLOWED_HOSTS`

Off by default. Comma-separated private hostnames (for example a Tailscale name, `box.tail1234.ts.net`) that the local
console admits besides `127.0.0.1` and `localhost`, matched against the request's Host. revbound dev still listens on
127.0.0.1 only; `tailscale serve --bg --https=<port> http://127.0.0.1:$REVBOUND_PORT` forwards that name to it with the
Host kept.

**Anyone on that private network gets in without a login** and reads Context, Workflows, Runs, Data and Connections.
Nothing there writes: `session` routes are read-only, and `automation` and `local` routes (start, run status, the run
inspector) answer only on `127.0.0.1`/`localhost`, so nobody else runs stages on the owner's subscription. Run workflows
on this machine with `npx revbound run`. Open database also works on this machine's own Tailscale name, for the
Tailscale login that presses it only (docs: data).

## `REVBOUND_BASE_PATH`

Off by default. A sub-path such as `/acme` that the whole local app answers under (Next's `basePath`), for sharing the
console on a path of a name that serves other things too:
`tailscale serve --bg --set-path /acme http://127.0.0.1:$REVBOUND_PORT/acme`, with the Tailscale name in
`REVBOUND_ALLOWED_HOSTS`. `revbound run` and `revbound dev` follow it. Set it in `.env.local` and restart
`revbound dev`.
