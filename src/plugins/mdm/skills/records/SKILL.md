---
name: mdm-records
description: Puts the people, companies and signals a Revbound workflow finds into mdm, the project's one de-duplicated set, and enriches each record only once. Use when writing or changing a workflow that finds, imports, enriches or watches people or companies, or records events such as job changes, job postings, funding rounds or site visits.
---

# mdm records

1. Read `npx revbound docs mdm` once per task.
2. For every person or company a workflow finds, call `upsertPerson` or `upsertCompany` from `#revbound/mdm` with every
   key it has (email, domain, LinkedIn URL, `ids` from other systems) and `{ source }` naming the vendor, site or list.
   Keep the returned `id`; store only that id in company tables, never a copy of the person or company.
3. Before any enrichment that costs money or time, call `stale(record, fields, { maxAgeDays })` and enrich only the
   fields it returns. Write the results back as `fields` with the vendor as `source`; write `null` for a field that was
   looked up and not found, so no later run pays for it again.
4. Record events with `upsertSignal({ about: record, type, at, key, data })`. Give `key` whatever identifies the event
   when found again (the posting's URL, the round's name, the vendor's event id).
5. When an upsert returns `conflicts`, its keys belong to other records. Merge them with `merge(keep, drop)` only when
   the person confirms they are one, or the keys prove it (the same email on both).
6. Preview the workflow (`npx revbound run <workflow> --preview`), then check People, Companies and Signals in the
   console.
