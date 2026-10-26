import { db } from "#revbound/database";
import { companies } from "../db/schema";

type Company = { name: string; domain: string };

/** "https://www.Acme.com/about" → "acme.com"; undefined when there is no domain in it. */
function domainOf(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0].replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

async function saveCompanies(rows: Company[], source: string | undefined) {
  "use step";
  const byDomain = new Map<string, { name: string; domain: string; source: string | null }>();
  const skipped: string[] = [];
  for (const row of rows) {
    const domain = domainOf(row.domain ?? "");
    if (!domain) skipped.push(row.name || row.domain);
    else byDomain.set(domain, { name: row.name?.trim() || domain, domain, source: source ?? null });
  }
  if (!byDomain.size) return { saved: 0, skipped };
  const saved = await db().insert(companies).values([...byDomain.values()])
    .onConflictDoUpdate({ target: companies.domain, set: { name: companies.name } }).returning({ id: companies.id });
  return { saved: saved.length, skipped };
}

/** Saves a supplied list of companies, one row per domain; rows without a domain are skipped and named. */
export async function importList(input: { companies: Company[]; source?: string }) {
  "use workflow";
  return await saveCompanies(input.companies, input.source);
}
