# MDM: people, companies and signals

`mdm` (master data management) keeps one de-duplicated set of **people**, **companies** and **signals** in the company's
own Postgres (schema `revbound_mdm`). Every workflow pushes what it finds into it and gets back the one record it
already is, or a new one. Enrichment runs on that set, so each person or company is enriched once, and every field says
where it came from and when.

It is optional. Add it to a project:

```sh
npx revbound add mdm          # prints the two lines below; nothing to install, it ships with the package
```

```ts
import { mdm } from "revbound/mdm";   // in revbound.config.ts
    mdm(),                                     // in plugins: [...]
```

Then `npx revbound sync` and `npx revbound migrate` (or restart `npm run dev`). It needs `database` and the ledger, and
uses `workflows` to stamp each write with its run. The console gets People, Companies and Signals.

## Records and their keys

| Record | Matched on | Named fields |
| --- | --- | --- |
| company | `domain`, `linkedin` (company page), `ids` | `name` |
| person | `email`, `linkedin` (profile), `ids` | `name`, `title`, `company` (where they work now) |
| signal | its record, its `type` and its `key` | `at`, `data` |

- Keys are normalized before matching: emails trimmed and lowercase; domains reduced to the host, lowercase, without
  `www.`, port or path (`https://www.Acme.com/about` is `acme.com`; other subdomains stay); LinkedIn URLs reduced to
  `linkedin.com/in/<slug>` or `linkedin.com/company/<slug>` (`school` and `showcase` pages count as companies).
- `ids: { hubspot: "123", apollo: "abc" }` are ids in other systems, matched exactly per system.
- Each key belongs to one record. A record can have several (two domains, an email and a profile), and a record id
  (`id`) always matches.
- When the keys given point at different records, the strongest wins (ids, then email or domain, then LinkedIn), the
  other records' keys stay with them, and the result's `conflicts` lists those records. Decide, then `merge()`.
- A person or company with no key at all is refused. mdm never matches on names.

## Helpers from `#revbound/mdm`

Each is one step, so call them from workflow code or inside your own steps.

| Helper | Returns |
| --- | --- |
| `upsertCompany(input, { source })` | the company: matched on its keys, or created; `created` and `conflicts` say which |
| `upsertPerson(input, { source })` | the person; `company: { domain }` (or a company record) matches or creates the company and links it |
| `upsertSignal({ about, type, at?, key?, data? }, { source })` | the signal, stored once per record, type and key; `created` |
| `findCompany(keys)`, `findPerson(keys)` | the record by any key or id, or null |
| `merge(keep, drop)` | the kept record |
| `known(record, fields?)` | `{ [field]: { value, source, workflow, runId, setAt } }`, keys included (`email`, `domain`, `linkedin`, `id:<system>`: the first of each) |
| `stale(record, fields, { maxAgeDays? })` | the fields to enrich: unknown ones, and ones set longer ago than `maxAgeDays` |
| `signals(record, { type?, limit? })` | its signals, newest first |

`source` names where the data came from: the vendor or site (`"apollo"`, `"website"`), or the list. It defaults to the
running workflow's name. Every write also records the workflow and its ledger run. Records come back as plain JSON
(`{ type, id, name, …, data, keys }`); pass a record wherever a record is wanted (`{ type, id }` is enough).

### Enrich once

```ts
import { agent } from "#revbound/ai";
import { stale, upsertCompany, upsertPerson } from "#revbound/mdm";
import { z } from "zod";

export async function importLeads(input: { leads: { email: string; name: string; domain: string }[] }) {
  "use workflow";
  let enriched = 0;
  for (const lead of input.leads) {
    const person = await upsertPerson({ email: lead.email, name: lead.name, company: { domain: lead.domain } }, { source: "lead-list" });
    const company = { type: "company", id: person.companyId! } as const;
    // Known and fresh already (from this or any other workflow): skip the paid call.
    if (!(await stale(company, ["industry", "employees"], { maxAgeDays: 90 })).length) continue;
    const profile = await agent({ name: "profile", instructions: "Read the company's website.", prompt: `https://${lead.domain}`,
      schema: z.object({ industry: z.string().nullable(), employees: z.number().nullable() }), tools: { web: { fetch: true } } });
    await upsertCompany({ id: company.id, fields: profile.value }, { source: "website" });
    enriched += 1;
  }
  return { enriched };
}
```

## Fields and where they came from

- `fields: { industry: "Software", employees: 40 }` on an upsert writes each field to the record (`data`) and records
  its source, workflow, run and time. The named fields (`name`, `title`, `company`) are recorded the same way.
- The latest write of a field wins, and its time is the time of that write: a field found again is fresh again.
- `null` records "looked, found nothing": the field counts as known, so the next run does not pay to look again.
  `undefined` writes nothing, and named fields are never cleared.
- Field names start with a letter and hold letters, digits, `_`, `.` or `-`; the keys and named fields have their own
  inputs.

## Signals

A signal is something that happened to a person or company: `job_change`, `job_posting`, `funding_round`,
`site_visit`, or any lowercase type. `about` is the record it is about, `at` when it happened (default now), and `key`
what makes it the same signal when found again: the posting's URL, the round's name, the vendor's event id. Without a
key, `at` is the key. `data` holds any details (`{ title, company, url }`). Found again, its `data` is merged in and the
earliest `at` stays.

## Merging

`merge(keep, drop)` folds two records that turn out to be one: `drop`'s keys, fields and signals move to `keep`
(where both have a field or the same signal, `keep`'s stays), people at a merged company move with it, and `keep`'s
named values win, with `drop`'s filling the gaps. `drop` stays as a marker: its id finds `keep` everywhere, in every
helper and in the console.

## The console

People, Companies and Signals are read-only lists, newest first, with search (names and every key), and Signals
filters by type and time. A person's or company's page shows its keys, every known field with its source and date,
its signals, and a company's people.

## For other plugins

A CRM, a sequencer or a vendor plugin reads and links to these records through the `mdm` slot:

```ts
import type { MdmSlotV1 } from "revbound/mdm";
// in definePlugin: uses: ["mdm"] (or needs: ["mdm"]); then in a route or step:
const mdm = ctx.get<MdmSlotV1>("mdm");
const person = await mdm.findPerson({ email });
await mdm.upsertCompany({ domain, fields: { employees } }, { source: "acme-vendor", workflow: null, runId: null });
```

- `MdmSlotV1` is the contract: the helpers above, with an explicit `origin` (`{ source, workflow, runId }`) on writes.
  A replacement keeps the plugin name `mdm` and the slot.
- Store a record's id (a uuid) in your own tables to link to it, never a copy of its fields. Ids never change; a merged
  id resolves to the record it went into (`findPerson({ id })`).
- Reading the tables directly is fine for reports and joins, never for writes: `revbound_mdm.people`,
  `revbound_mdm.companies` (live rows have `merged_into is null`), `revbound_mdm.signals`, `revbound_mdm.keys`
  (`record_type`, `key`, `value`, `record_id`) and `revbound_mdm.fields` (`record_id`, `field`, `value`, `source`,
  `workflow`, `run_id`, `set_at`).
- Push ids from your system as `ids: { <system>: id }`, so later writes from it match the same record.

More record types (job postings, say) can join later: keys, fields and signals already name their record by type.

## Deleting a person

To delete everything mdm holds about one person, after a yes in chat:

```sql
with p as (select id from revbound_mdm.people where id = (select record_id from revbound_mdm.keys where key = 'email' and value = 'person@example.com'))
, s as (delete from revbound_mdm.signals where record_id in (select id from p))
, f as (delete from revbound_mdm.fields where record_id in (select id from p))
, k as (delete from revbound_mdm.keys where record_id in (select id from p))
delete from revbound_mdm.people where id in (select id from p) or merged_into in (select id from p);
```

The ledger keeps its own natural keys (docs: ledger).

## Not in mdm

No CRM sync and no paid data sources: those are plugins and workflows that write here.
