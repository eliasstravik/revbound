# Revbound

**The open-source agent plugin that runs your GTM.**

Add it to Claude Code, Codex, Copilot CLI or Cursor and say "set up GTM for Acme". Your agent builds the workflows.
Revbound runs them on Vercel, keeps a record of every run and dollar, and gives your team a console. Your repo, your
keys, and every part is a plugin.

```sh
npx skills add eliasstravik/revbound -g     # the skill, for any agent
# then ask your agent: "set up GTM for Acme"
npm run dev                                 # in ./revbound-acme: the console on http://127.0.0.1:3000
```

Or install it as your agent's plugin:

| Agent | Install |
| --- | --- |
| Claude Code | `/plugin marketplace add eliasstravik/revbound`, then `/plugin install revbound@eliasstravik` |
| Codex | `codex plugin marketplace add eliasstravik/revbound`, then `codex plugin add revbound@eliasstravik` |
| GitHub Copilot CLI | `copilot plugin marketplace add eliasstravik/revbound`, then `copilot plugin install revbound@eliasstravik` |
| Cursor | `git clone https://github.com/eliasstravik/revbound ~/.cursor/plugins/local/revbound`, then **Developer: Reload Window** |
| Any host that reads `plugin.json` | `npx plugins add eliasstravik/revbound` |

## What it is

Revbound doesn't build the "how" of go-to-market work: playbooks, scoring, templates, enrichment waterfalls or vendor
wrappers. Agents write those, and they get better at it every year. Revbound builds the parts agents plug into, the ones
no company should have to rebuild:

- durable execution (Workflow SDK workflows, on Vercel Workflow when live)
- a place to keep records (the company's own Postgres: PGlite locally, Neon live)
- a safe path for keys (environment variables; values never in chat, the console or git)
- a screen for teammates who don't use an agent (the console: read and navigation only)
- a lasting record of what ran, what it cost and who said yes (the ledger)
- access control on every route

Locally it needs no sign-ups: a built-in Postgres, the Workflow SDK's local world, and AI steps on your own `claude` or
`codex` login. Live, the same project is one Vercel project behind Vercel's own login. Nothing is hosted by this
project, there is no telemetry, and the keys and services are the company's own.

## Every part is a plugin

`revbound init` writes `revbound.config.ts` with seven default plugins, each one line you can remove or replace:

| Plugin | What it does |
| --- | --- |
| `database` | `db()` on the company's Postgres, migrations, the Data view |
| `ledger` | every run, refused start, cost and approval; budgets; the Runs view |
| `workflows` | the workflow registry, the one start path, `fanOut()`, webhooks, schedules, `revbound run` |
| `ai` | `agent()`: every AI call, metered and capped |
| `context` | the company's context and skills, the console's home |
| `connections` | which keys are set, and `revbound connections set` for local ones |
| `console` | the console's frame, for every plugin's pages |

Optional plugins ship in the package too and join a project with `npx revbound add <name>`:

| Plugin | What it does |
| --- | --- |
| `mdm` | one de-duplicated set of people, companies and signals that every workflow matches to, with where each field came from, so each record is enriched once; People, Companies and Signals views |

A plugin can add tables, console pages and sidebar items, workflow tabs, routes with an access rule, CLI commands,
skills, AGENTS.md lines, connection names, checks and docs, without editing this package. `revbound sync` turns the list
into committed files, `revbound check` runs first in every build, and `revbound add`, `remove`, `eject` and `diff`
manage plugins. See [docs/plugins.md](docs/plugins.md).

## A yes is a record

A workflow marked `approval: { required: true }` spends nothing without a recorded yes: your agent runs a preview,
shows you the sample and the cost, asks Yes/No in chat, and only then runs it with `--approve --max-usd`. Schedules are
approved in the registry, through git. Every metered call is reserved before it runs against the run's budget, the
approved total and the monthly caps. See the [ledger](src/plugins/ledger/docs/ledger.md) docs.

## Docs

The docs match the installed version: `npx revbound docs [topic]` in a project.

| Topic | |
| --- | --- |
| [plugins](docs/plugins.md) | the plugin list, writing a plugin, the contract, slots and binding files, the entry rule |
| [layout](docs/layout.md) | the project layout and what is whose |
| [workflows](src/plugins/workflows/docs/workflows.md) | the registry, `fanOut`, preview → yes → `--approve`, `revbound run`, run size |
| [ledger](src/plugins/ledger/docs/ledger.md) | approvals, schedules, budgets, `action()`, failure modes, deleting natural keys |
| [ai](src/plugins/ai/docs/ai.md) | `agent()`, its backends, models and cost |
| [data](src/plugins/database/docs/data.md) | `db()`, migrations, the production stamp, local data |
| [connections](src/plugins/connections/docs/connections.md) | keys, locally and live |
| [context](src/plugins/context/docs/context.md) | the basics at setup, and a suggested layout for company facts |
| [webhooks](src/plugins/workflows/docs/webhooks.md) | inbound webhooks |
| [mdm](src/plugins/mdm/docs/mdm.md) | people, companies and signals: matching, merging, where each field came from, the contract for other plugins |
| [recipes](docs/recipes.md) | ready-made workflows to copy |
| [interaction](docs/interaction.md) | how agents talk to the GTM team |
| [local](docs/local.md), [deploy](docs/deploy.md), [upgrade](docs/upgrade.md) | working locally, going live, upgrading from 0.0.x |

## Deploy

The live project is the same repo as one Vercel Pro project with Neon from the Vercel Marketplace, behind Vercel
Authentication on all deployments. Follow [docs/deploy.md](docs/deploy.md); `npx revbound check --prod` says what is
missing.

[![Deploy with
Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Feliasstravik%2Frevbound%2Ftree%2Fv0.0.7%2Fstarter&project-name=revbound-company&repository-name=revbound-company&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

The button deploys the starter at `v0.0.7`; name the project `revbound-<company>`. The console fails closed ("Turn on
Vercel Authentication → All Deployments") until production protection is on.

## Roadmap

Each starts as an optional plugin, and joins the defaults only by the entry rule in [docs/plugins.md](docs/plugins.md).

| Next | When |
| --- | --- |
| An MCP server for Revbound | agents outside a CLI need to work through Revbound |
| A sequencer slot with a local test channel, a send guard, an opt-out list and `revbound ledger forget` | sending work starts |
| An in-app CRM: tables and pages inside Revbound with a small read contract for the send guard, on mdm's people and companies | it is built |
| More mdm record types (job postings first), and mdm joining the defaults | workflows need them; mdm meets the entry rule |
| A chat channel plugin | demand, and a way to verify who approves |
| Signing in with an existing coding-agent subscription for local AI steps | a local AI path without `claude` or `codex` is needed |
| Keys outside the project folder, and OAuth connections | vendors need OAuth, or local keys must leave the folder |
| Enrichment, other engines, vendor plugins (writing to mdm) | demand; vendors or the community build them |
| A practice arena for outreach | a backtest on real logs beats a simple baseline at predicting past reply rates |
| A sell-to-me endpoint | a B2B quote standard exists and buyers query vendors through it in production |

Not planned: a hosted Revbound service run by this project.

## Developing Revbound

```sh
npm ci
npm run build && npm run check        # typecheck and unit tests
npm test                              # unit tests, then the acceptance suite against a packed tarball
REVBOUND_TEST_PG_URL=postgres://… node --test test/ledger/*.test.mjs test/mdm/*.test.mjs   # the ledger and mdm on real Postgres and on PGlite
npm run lines                         # line counts per plugin against their budgets
```

Releases: `npm run version:bump <x.y.z>` sets one version across the package, the plugin manifests, the starter's pin
and the Deploy button; [release.yml](.github/workflows/release.yml) publishes a pushed `v<x.y.z>` tag through npm
trusted publishing after `npm run check` passes.

## License

[MIT](LICENSE)
