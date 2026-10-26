import { definePlugin } from "revbound";

export type * from "./types.js";
export type { WriteOptions } from "./runtime.js";

const P = "revbound/mdm";
const SRC = "revbound/src/plugins/mdm";

/**
 * The `mdm` slot (master data): one de-duplicated set of people, companies and signals in the company's Postgres, each
 * field with where it came from and when, so every workflow matches what it finds to one record and enriches it once.
 * Optional: a company adds it with `revbound add mdm`.
 */
export function mdm() {
  return definePlugin({
    name: "mdm",
    api: 1,
    provides: ["mdm"],
    provide: `${P}/provide`,
    needs: ["database"],
    uses: ["workflows"],
    capabilities: ["writesPeople"],
    runtime: { from: `${P}/runtime`, step: `${P}/step`, exports: ["upsertCompany", "upsertPerson", "upsertSignal", "findCompany", "findPerson", "merge", "known", "stale", "signals"] },
    migrations: `${SRC}/migrations`,
    tables: [
      { schema: "revbound_mdm", name: "people", label: "MDM: people" },
      { schema: "revbound_mdm", name: "companies", label: "MDM: companies" },
      { schema: "revbound_mdm", name: "signals", label: "MDM: signals" },
      { schema: "revbound_mdm", name: "keys", label: "MDM: matching keys" },
      { schema: "revbound_mdm", name: "fields", label: "MDM: where each field came from" },
    ],
    routes: [
      { path: "mdm/people", methods: ["GET"], access: "session", handler: `${P}/routes#people` },
      { path: "mdm/people/:id", methods: ["GET"], access: "session", handler: `${P}/routes#person` },
      { path: "mdm/companies", methods: ["GET"], access: "session", handler: `${P}/routes#companies` },
      { path: "mdm/companies/:id", methods: ["GET"], access: "session", handler: `${P}/routes#company` },
      { path: "mdm/signals", methods: ["GET"], access: "session", handler: `${P}/routes#signals` },
    ],
    views: [
      { path: "people", title: "People", nav: { label: "People", order: 30 }, fill: true, component: `${P}/views#PeopleView` },
      { path: "people/:id", title: "Person", component: `${P}/views#PersonView` },
      { path: "companies", title: "Companies", nav: { label: "Companies", order: 31 }, fill: true, component: `${P}/views#CompaniesView` },
      { path: "companies/:id", title: "Company", component: `${P}/views#CompanyView` },
      { path: "signals", title: "Signals", nav: { label: "Signals", order: 32 }, fill: true, component: `${P}/views#SignalsView` },
    ],
    agents: `- People, companies and signals a workflow finds go into mdm with \`upsertPerson\`, \`upsertCompany\` and \`upsertSignal\` from
  \`#revbound/mdm\`, which match them to the one existing record (email, domain, LinkedIn URL or an id in another system) or create
  it. Before enriching a record, ask \`stale(record, fields, { maxAgeDays })\` and enrich only what it returns; write the
  results back as \`fields\` with the vendor as \`source\`. Never keep a second copy of people or companies in company
  tables: store the mdm id instead (docs: mdm).`,
    skills: [`${SRC}/skills/records`],
    docs: { mdm: `${SRC}/docs/mdm.md` },
  });
}
