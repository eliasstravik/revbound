# Connections

A connection is an environment variable the company's workflows read: an API key or another value for one of the
company's own services. Revbound stores no values anywhere of its own, and the console never writes one.

## The list

- `.env.example` keeps every connection name in the repo, with an empty value and a one-line label in a `#` comment
  directly above it. A blank line between the comment and the name means no label. When a workflow needs a new key,
  add its name there in the same change. Plugins may declare names too; a name declared twice is one row.
- The Connections view lists those names, plus the names workflows declare in their registry entry's `connections`.
  Each row shows the label, the name, whether it is set here (Set, Missing, Provided by Vercel) and what uses it.
  Missing ones come first, and the sidebar counts them. Values are never shown.
- Locally, "set" means `.env.local` or the shell that started `revbound dev` has a value. Hosted, it means this
  deployment's own environment has one; Vercel's `[SENSITIVE]` placeholder from `vercel env pull` counts as unset.
  `AI_GATEWAY_*` names show Provided by Vercel when hosted: the deployment's OIDC identity stands in for them.

## Local keys

Hand the person the command; never ask for a value in chat:

```sh
npx revbound connections set APOLLO_API_KEY      # a hidden prompt; or pipe the value on stdin
npx revbound connections list
npx revbound connections delete APOLLO_API_KEY
```

- `set` reads the value from a no-echo prompt (or stdin) and refuses one given as an argument, so it never lands in
  shell history. It writes `.env.local` with mode 0600, in single quotes (backticks if the value contains `'`) with
  `$` written as `\$`, which Next's env loading reads back unchanged. The file is written whole and renamed into
  place; other entries are kept. The dev server picks it up within seconds.
- Values must be one line, not contain both `'` and `` ` ``, and not end in `\`.
- Never these names: `DATABASE_URL*`, `POSTGRES_*`, `PG*`, `CRON_SECRET`, `REVBOUND_*`, `VERCEL_*`, `NEON_*`. Revbound,
  Vercel or an integration sets those.
- A key set in the shell that started `revbound dev` wins over `.env.local`; its row says so.
- **Agents can read local keys.** `.env.local` sits in the project folder, and coding agents working there can read
  files in it even when ignore files exclude them. Keep production keys out of `.env.local`, and use keys with the
  least access the work needs. Moving local keys out of the folder is on the roadmap.

## Production keys

Production keys live in Vercel, set with its CLI or dashboard, then a redeploy (the running deployment keeps the
values it started with):

```sh
vercel env add APOLLO_API_KEY production --sensitive   # paste the value at its prompt
vercel env rm APOLLO_API_KEY production
vercel env ls production
```

- Use Production only for these, never a variable shared across environments, so a preview or a laptop never gets
  production's key. Preview and Development keys are set the same way with their own environment.
- The deployment holds no Vercel token and has no code that writes variables, so nothing reachable from the internet
  can change a key.
