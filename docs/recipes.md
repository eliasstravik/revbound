# Recipes

Ready-made workflows to copy into a project when a person asks for one, never on the agent's own initiative.
`init` adds none (`init --example` adds a separate, marked example for demos). Read one with
`npx revbound docs recipes/<name>`; its files are in `node_modules/revbound/docs/recipes/<name>/`.

| Recipe | Builds | Requests like |
| --- | --- | --- |
| [import-list](recipes/import-list/README.md) | a `companies` table filled from a supplied list, browsable and exportable in Data | "save this list of companies", "import these accounts" |
| [enrich-companies](recipes/enrich-companies/README.md) | each saved company's website read by an AI step into a short profile | "enrich our companies", "what does each of these companies do" |
| [weekly-new-companies](recipes/weekly-new-companies/README.md) | a scheduled job: every Monday, a count of the companies saved that week | "every week, tell me how many new companies came in" |

Each recipe folder mirrors the project: copy `workflows/<name>.ts` as is, append `schema.ts` (when there is one) to
`db/schema.ts`, add the registry entry its README gives to `workflows/index.ts`, then run `npm run db:generate`,
`npx revbound migrate` and `npx revbound check`. Rename tables and fields to the company's words when the
person wants; a recipe is a starting point, not a contract.

Rules every recipe keeps:

- Ask where the list comes from (a CSV, an existing table, a service) when the person has not said; never default to
  a vendor. A service the person names is called from a step written against its documentation, with its key added
  to `.env.example` (docs: connections).
- Building a workflow starts no paid run. Preview, then a yes in chat, then `--approve` (`npx revbound docs ledger`).
