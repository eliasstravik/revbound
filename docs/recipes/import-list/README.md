# Recipe: import a list

Saves a supplied list of companies to a `companies` table, one row per domain, so the team can browse, search and
export it in the Console's Data view. Other recipes (enrich-companies, weekly-new-companies) build on this table.

## Files

- `workflows/import-list.ts`: copy as is.
- `schema.ts`: append to `db/schema.ts`.
- Registry entry in `workflows/index.ts` (with `import { importList } from "./import-list";`):

```ts
"import-list": {
  run: importList,
  description: "Saves a list of companies, one row per domain, so they show in Data.",
  tables: ["companies"],
  diagram: {
    nodes: [
      { id: "in", label: "A list of companies", kind: "input", explanation: "Names and domains or website links." },
      { id: "save", label: "Save each company", kind: "output", explanation: "One row per domain in companies; rows without a domain are skipped." },
    ],
    edges: [{ source: "in", target: "save" }],
  },
},
```

## How to

1. Copy the files, then `npm run db:generate` and `npx revbound migrate`.
2. Turn what the person gave (a pasted list, a CSV, a spreadsheet export) into `{ "companies": [{ "name", "domain" }],
   "source": "<where it came from>" }`; a website link works as the domain. A large file goes in runs of about 100
   rows (`npx revbound docs workflows`, run size).
3. `npx revbound run import-list --input '<json>'`; the result says how many were saved and which rows had
   no domain. The rows show in Data → companies.

Saving costs nothing, so it needs no preview. Saving the same domain again updates its row instead of adding one.
