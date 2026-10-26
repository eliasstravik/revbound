# Recipe: a weekly count of new companies

A scheduled job: every Monday at 07:00 UTC it counts the companies [import-list](../import-list/README.md) saved in
the past 7 days and keeps one row per week in `weekly_new_companies`, which Data shows. The pattern fits any
scheduled job: a workflow that takes no input, registered by name, plus one cron in `vercel.json`.

## Files

- `workflows/weekly-new-companies.ts`: copy as is.
- `schema.ts`: append to `db/schema.ts` (after import-list's table, which it reads).
- Registry entry in `workflows/index.ts` (with `import { weeklyNewCompaniesCount } from "./weekly-new-companies";`):

```ts
"weekly-new-companies": {
  run: weeklyNewCompaniesCount,
  description: "Every Monday, counts the companies saved in the past week.",
  tables: ["weekly_new_companies"],
  diagram: {
    nodes: [
      { id: "when", label: "Every Monday 07:00 UTC", kind: "input", explanation: "Vercel Cron, in production only." },
      { id: "count", label: "Count last week's companies", kind: "action", explanation: "Companies saved in the 7 days before the run." },
      { id: "save", label: "Keep the count", kind: "output", explanation: "One row per week in weekly_new_companies." },
    ],
    edges: [{ source: "when", target: "count" }, { source: "count", target: "save" }],
  },
},
```

- In `vercel.json`, add to `crons`: `{ "path": "/api/gtm/cron/weekly-new-companies", "schedule": "0 7 * * 1" }`.

## How to

1. Copy the files, then `npm run db:generate` and `npx revbound migrate`.
2. Try it locally, where nothing fires on its own: `npx revbound run weekly-new-companies`.
3. The schedule runs only in production, with `CRON_SECRET` set (`npx revbound docs deploy`). It costs nothing, so its yes is the
   person asking for the schedule; a schedule that does cost something quotes cost per run × runs per month first.
