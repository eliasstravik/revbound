# Interactions: Revbound

Contents: [Set up](#set-up) · [Add context when asked](#add-context-when-asked) · [Risky run](#risky-run)

The numbered choices stand for the host's native question tool.

## Set up

**Setup:** No Revbound project in this folder.

**Human:** Set up GTM for Acme. We sell product analytics to SaaS teams, acme.example.

**Agent:** Creating the Acme project with the basics: its name and a short description from that and a quick look at
acme.example; about a minute.

Created Acme's project. Its description says Acme sells product analytics to SaaS teams. What next?

1. Describe who to sell to (Recommended)
2. Add the buyers to reach
3. Build a first workflow
4. Something else

**Human:** Nothing for now.

**Agent:** Saved. Acme's project is ready whenever there is more to add.

**Files:**
- created the project folder `gtm-acme/` (`init --company Acme`)
- changed `context/company.md` (heading and description only)

## Add context when asked

**Setup:** Project gtm-acme exists with only `context/company.md`.

**Human:** Add our ICP: B2B SaaS companies, 50 to 200 people, US or UK, on HubSpot.

**Agent:** Creating the ICP B2B SaaS: B2B software, 51–200 employees, US or UK, HubSpot. The other criteria stay
Unknown until supplied; Acme's own facts do not define prospect criteria.

Created B2B SaaS. What next?

1. Add the buyers to reach (Recommended)
2. Build a workflow that scores companies against it
3. Nothing for now

**Files:**
- created `context/icps/b2b-saas.md` (shape from `revbound docs context`)

## Risky run

**Setup:** The workflow Score inbound accounts calls a paid enrichment API per row; its registry entry has
`approval: { required: true }`.

**Human:** Run Score inbound accounts on last month's 800 signups.

**Agent:** Running a preview on last month's signups first; about a minute.

The preview scored 3 sample signups: 2 fit. The full run of 800 costs about $12 in enrichment and model calls; I will
cap it at $15. Run Score inbound accounts on all 800 signups, up to $15?

Options: Yes; No.

**Human:** Yes.

**Agent:** Running Score inbound accounts on 800 signups, up to $15; about 20 minutes.

Done. 512 of 800 fit, for $11.40; the Data view's qualified_companies table has every verdict.

**Commands:**
- `npx revbound run score-inbound --input '{"month":"2026-09"}' --preview`
- after the Yes: `npx revbound run score-inbound --input '{"month":"2026-09"}' --approve --max-usd 15 --note "Yes in chat"`
