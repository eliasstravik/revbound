# Connections

A connection is an environment variable the company's workflows read: an API key or another value for one of the
company's own services. Revbound stores no values anywhere of its own: locally they live in `.env.local`, hosted in the
Vercel project's Production environment.

## The list

- `.env.example` keeps every connection name in the repo, with an empty value and a one-line label in a `#` comment
  directly above it. A blank line between the comment and the name means no label. When a workflow needs a new key,
  add its name there in the same change. Plugins may declare names too; a name declared twice is one row.
- The Connections view lists those names, the names workflows declare in their registry entry's `connections`, and
  the names already set: locally in `.env.local`, hosted in Production (read with `REVBOUND_VERCEL_TOKEN`). Each row
  shows the label (hosted, the Vercel variable's Note first), the name, its state here (Set, Missing, Saved not live
  yet, Provided by Vercel, Read only) and what uses it. Missing ones come first, and the sidebar counts them.
- Locally, "set" means `.env.local` or the shell that started `revbound dev` has a value. Hosted, it means this
  deployment's own environment has one; Vercel's `[SENSITIVE]` placeholder from `vercel env pull` counts as unset.
  `AI_GATEWAY_*` names show Provided by Vercel when hosted: the deployment's OIDC identity stands in for them.
- Values are never shown back, logged or put in chat. The person types them into the console's form or the CLI's
  hidden prompt; never ask for a value in chat.

## Add, Edit, Delete

- **Add connection** takes a name (the label, such as `Apollo`, or `HubSpot (Sandbox)` to tell two accounts apart), a
  key (letters, digits and `_`, not starting with a digit, such as `APOLLO_API_KEY`) and a value. A missing row has
  its own Add. A key that is already set is changed with Edit instead.
- **Edit** (the row's ⋯ menu) changes the label, the value, or both; the key stays. An empty value keeps the old one.
- **Delete** asks first and names the workflows using the key; they stop working until it is added again.
- A value typed in the form is cleared when the form closes or the page is left.
- Values must be one line of at most 32 KB, not contain both `'` and `` ` ``, and not end in `\`; labels are one line
  of at most 256 characters.
- Never these names: `DATABASE_URL*`, `POSTGRES_*`, `PG*`, `CRON_SECRET`, `REVBOUND_*`, `VERCEL_*`, `NEON_*`,
  `SLACK_*`, `GITHUB_*`, `EVE_*`, and hosted also `AI_GATEWAY_*`. Revbound, Vercel or an integration sets those (for
  example `vercel env add`); listed in `.env.example`, they show without actions.

## Locally

The form works on `127.0.0.1`/`localhost`, and for a Tailscale login on a `REVBOUND_ALLOWED_HOSTS` name (docs: local);
changes are accepted from the console's own page only. The same writes from a terminal:

```sh
npx revbound connections set APOLLO_API_KEY      # a hidden prompt; or pipe the value on stdin
npx revbound connections list
npx revbound connections delete APOLLO_API_KEY
```

- Add and Edit write the value to `.env.local` with mode 0600, in single quotes (backticks if it contains `'`) with
  `$` written as `\$`, which Next's env loading reads back unchanged. The console also appends a new name to
  `.env.example` as `# <label>` and `NAME=`, and a label change rewrites the comment above it; Delete removes the name
  from both files. Files are written whole and renamed into place; other lines are kept. The dev server picks the
  change up within seconds, with nothing to restart.
- `set` reads the value from a no-echo prompt (or stdin) and refuses one given as an argument, so it never lands in
  shell history. It leaves `.env.example` to you.
- A key set in the shell that started `revbound dev` wins over `.env.local`; its row says so, and a change applies only
  once the shell stops setting it and `revbound dev` restarts.
- **Agents can read local keys.** `.env.local` sits in the project folder, and coding agents working there can read
  files in it even when ignore files exclude them. Keep production keys out of `.env.local`, and use keys with the
  least access the work needs.

## Production keys

On the deployed console, Add, Edit and Delete change the project's Production variables, once the project has a
Vercel token (docs: deploy, step 12):

- Changes work only on the production domain (`VERCEL_PROJECT_PRODUCTION_URL`), because Vercel's login cookie is per
  domain, and only from a browser that passed Vercel Authentication: the login cookie is checked against a protected
  probe, an anonymous probe must be refused, and every change carries a token bound to that login. Bypass, bearer and
  OIDC callers are refused. On a preview or any other domain the list is read-only.
- Add and Edit write the value to Production only, as a Sensitive variable with the label as its Note, then redeploy
  the newest production deployment so it picks the value up (about a minute; the row reads "Saved, not live yet"
  until then). A label-only Edit changes the Note and redeploys nothing. Delete removes the variable and redeploys.
- When the redeploy fails, or is skipped because a rollback pins production, a notice offers **Redeploy**, which
  redeploys again without sending any value.
- A variable shared with other environments, one an integration or Vercel owns, and a system one show Read only, with
  Open in Vercel; change those in the dashboard. Preview and Development values are set there or with
  `vercel env add <NAME> preview`.
- Without `REVBOUND_VERCEL_TOKEN`, the console shows Open in Vercel and the `vercel env add` command instead:

  ```sh
  vercel env add APOLLO_API_KEY production --sensitive   # paste the value at its prompt
  vercel env rm APOLLO_API_KEY production
  vercel redeploy <production deployment url>
  ```

- From 14 days before `REVBOUND_VERCEL_TOKEN_EXPIRES`, Connections shows a warning; replace the token (docs: deploy).
- Anyone past Vercel's login (every Viewer) can change production keys; Vercel's activity log credits the token's
  owner. The token is scoped to this project, lives only in Production, and never reaches the chat agent's sandbox.
  Code deployed to the project is trusted with it, as with every other key: review what you deploy.
