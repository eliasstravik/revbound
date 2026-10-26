// An example from `revbound init --example`: saves a list of companies to the example_companies table, which the
// console's Data view shows. `npx revbound run example-import` saves three sample companies.
//
// To remove the example before anything reached production: delete this file and context/example-icp.md, empty
// the registry in workflows/index.ts and db/schema.ts back to `export {}`, delete db/migrations/, and delete .gtm/
// (the local database) so the table goes too.
import { db } from "#gtm/database";
import { exampleCompanies } from "../db/schema";

type Company = { name: string; domain: string };

const SAMPLE: Company[] = [
  { name: "Acme", domain: "acme.example" },
  { name: "Globex", domain: "globex.example" },
  { name: "Initech", domain: "initech.example" },
];

async function saveCompanies(companies: Company[]) {
  "use step";
  const rows = companies.map((c) => ({ name: c.name.trim(), domain: c.domain.trim().toLowerCase() }));
  if (!rows.length) return 0;
  const saved = await db().insert(exampleCompanies).values(rows)
    .onConflictDoUpdate({ target: exampleCompanies.domain, set: { name: exampleCompanies.name } }).returning();
  return saved.length;
}

/** Example: saves the given companies (or three samples), one row per domain. */
export async function exampleImport(input?: { companies?: Company[] }) {
  "use workflow";
  return { saved: await saveCompanies(input?.companies ?? SAMPLE) };
}
