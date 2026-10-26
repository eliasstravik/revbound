# Deploy

The live project is the same repo as one Vercel project. `init` only writes files; the agent does every account
step with the vendors' own CLIs and dashboards. Our conventions:

1. **Vercel Pro.** Hobby is for non-commercial use, and Workflow run data stays readable for days only. The ledger
   keeps the lasting record in your own Postgres.
2. **Neon through the Vercel Marketplace**: production's branch on Production, preview branching (or no database) on
   Preview, a dev branch on Development. Never production's database on Development:
   `vercel integration add neon --name <name> -e production --no-env-pull` connects Production only.
3. **Vercel Authentication on All Deployments** (`ssoProtection.deploymentType` `"all"`). Every other value leaves
   the production domain public. Until it is on, every page and console route answers "Turn on Vercel
   Authentication → All Deployments" instead of content (checked per host, cached 5 minutes).
4. **"Automatically expose System Environment Variables" on.** Vercel Workflow needs them; without them runs fall
   back to a local store and fail. Revbound knows it is hosted from `VERCEL_ENV` plus `VERCEL_DEPLOYMENT_ID`.
5. **No Deployment Protection Exceptions and no Shareable Links**, ever.
6. **Teammates get Viewer invites.** Never approve access requests from outsiders.
7. **`CRON_SECRET`** on Production (`vercel env add CRON_SECRET production`, a long random value): workflow
   schedules and the ledger's hourly reconcile (`/api/gtm/ledger/reconcile` in `vercel.json`) are refused while it is
   unset.
8. **`GTM_AGENT_BACKEND`** (and `GTM_MODEL` if set) as Production variables, so hosted runs stay on the laptop's model
   family (docs: ai). Hosted AI runs on AI Gateway through OIDC; set its own budgets in the Vercel dashboard as the
   outer ceiling (docs: ledger).
9. **The bypass secret for laptops**: the Protection Bypass for Automation secret (Project Settings → Deployment
   Protection) that deployments see as `VERCEL_AUTOMATION_BYPASS_SECRET`, copied to `.env.local` as
   `GTM_BYPASS_SECRET` with `GTM_PRODUCTION_URL` (`https://<production domain>`) for `npx revbound run --prod`. It reaches
   only `automation` routes (`start/:name`, `runs/:id`); pages and console routes refuse it. Redeploy once after
   creating it.
10. **One separate, labeled bypass secret per webhook sender**, never the one above, stored as
    `GTM_HOOK_<NAME>_BYPASS` so its route accepts it and no other (docs: webhooks).
11. **`npx revbound check --prod`** before calling it live: production must answer with Vercel's login, the project must
    have no Exceptions or Shareable Links, system variables exposed and `CRON_SECRET` set. It also prints every
    `acknowledge` entry in gtm.config.ts.

## Production keys

The deployment holds no Vercel token and writes no variables; the console only shows which names are set. Add or
change a key with the Vercel CLI, then redeploy:

```sh
vercel env add APOLLO_API_KEY production --sensitive   # paste the value at the prompt
vercel env rm APOLLO_API_KEY production
vercel env ls production
vercel redeploy <production deployment url>
```

Never change a variable shared across environments from here, and leave names Revbound, Vercel or an integration own
(`DATABASE_URL*`, `POSTGRES_*`, `PG*`, `CRON_SECRET`, `GTM_*`, `VERCEL_*`, `NEON_*`) to them.

## Notes

- The build is `revbound check --build && revbound migrate && next build`: every deploy checks the project, then applies
  pending migrations, before Next builds. A hosted-production `revbound migrate` refuses destructive migrations unless
  acknowledged (docs: data).
- A `vercel deploy` from a laptop uploads what `.vercelignore` does not exclude; the starter's repeats `.gitignore`
  and adds the generated `app/.well-known/workflow/`. Git deploys follow `.gitignore`.
- `vercel link` appends `.env*` to `.gitignore`, which would also hide `.env.example`; put it back to `.env*.local`.
- `scripts/smoke-live.mjs` in the revbound repository checks a real deployment by hand (preview, approve, a cron tick,
  reconcile, ledger rows).
