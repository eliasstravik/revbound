# Context

`context/` is what the company knows, as Markdown in any shape; the console's Context view lists every `.md` file
under it, titled by its first heading. `init` writes only `context/company.md`. Everything else is added when a
person asks for it, never on the agent's own initiative.

Facts go in `context/` (what the company is, sells and targets). A procedure (how to write a cold email in the
company's voice, how to research an account) is a skill instead: `.agents/skills/<name>/SKILL.md` (docs: layout,
where things go). `AGENTS.md` is neither; it holds the coding agents' instructions.

## The basics

At setup `context/company.md` gets only the company's name as its first heading and a short description: what the
company sells, to whom and why they buy, from what the person said, or a quick look at the company's own site when they
gave one. The console shows the name from `company` in revbound.config.ts. Then the agent asks what to add next (docs:
interaction).

## Suggested layout

A suggestion, not a contract: read this topic when a person asks for one of these kinds, and use its folder and
shape unless the project already does it differently. Companies add their own kinds of context freely (voice,
competitors, objections, pricing, case studies, playbooks), in whatever folders fit.

| Kind | File | First heading |
| --- | --- | --- |
| Company facts | `context/company.md` | the company's name |
| The company's own people | `context/members/<slug>.md` | the person's full name |
| Ideal customer profiles (target accounts) | `context/icps/<slug>.md` | the ICP's name |
| Buyer or stakeholder personas (target people) | `context/personas/<slug>.md` | the persona's name |

A slug is the first heading in lowercase ASCII kebab-case, 1–40 characters, unique in its folder. Folders appear
only when their first file does. A file links to another with a relative link (`icps/lean-b2b-saas.md`), which the
Console opens in place.

## Sourcing

Facts come from the person, the company's own public site and other safe public sources; never invented. A field
nobody has confirmed says `Unknown`. An ICP or persona holds only the criteria the person gave: never derive them
from the company's own facts or its members. A member's email comes from the person or a source, never inferred.

## Company data

Thirteen fields, in this order, one line each. In `company.md`, under `## Company data` after the description,
they are facts about the company; in an ICP, under `## Company data`, they are the accepted criteria for target
accounts, where ranges and lists of accepted values are allowed. Add the section to `company.md` only when the
person asks for company facts. Nested bullets appear only under Location, Products and services, and Tech stack.

| Field | In `company.md` (fact) | In an ICP (criterion) |
| --- | --- | --- |
| Business types | B2B, B2C, marketplace and the like | accepted types |
| Industries | the industries it operates in | accepted industries |
| Subindustries | narrower segments within those industries | accepted segments |
| Revenue streams | how it earns: subscriptions, services, transactions | accepted models |
| Annual revenue | amount or range, noting when estimated | accepted range |
| Company size | headcount band | accepted band |
| Company type | privately held, public, nonprofit, government | accepted types |
| Description | what the company does, in one sentence | what the accounts look like |
| Domain | primary web domain | accepted domain patterns, or `Unknown` |
| Employees | headcount, noting when estimated | accepted range |
| Location | headquarters and offices | accepted countries or regions |
| Products and services | what it sells | what the accounts sell |
| Tech stack | tools it is known to use | required or accepted tools |

An ICP may add `## Company signals` (one line per signal that raises fit) and `## Disqualifiers` (one line per rule
that rules an account out); leave out a section that would be empty.

```md
# Lean B2B SaaS

## Company data

- Business types: B2B
- Industries: Software
- Subindustries: Unknown
- Revenue streams: Subscriptions
- Annual revenue: Unknown
- Company size: 51–200
- Company type: Unknown
- Description: Unknown
- Domain: Unknown
- Employees: Unknown
- Location: United States, United Kingdom
- Products and services: Unknown
- Tech stack: HubSpot or Salesforce

## Disqualifiers

- Agencies and consultancies
```

## Person data

A persona holds the accepted criteria for target people in these eleven fields, in this order, one line each,
under `## Person data`, and may add `## Person signals` and `## Disqualifiers` like an ICP.

| Field | Criterion |
| --- | --- |
| Job titles | accepted titles |
| Seniority | accepted levels: individual contributor, manager, director, VP, C-level |
| Years of experience | accepted range |
| Function | accepted departments: sales, marketing, operations and the like |
| Location | accepted countries or regions |
| Languages | required or accepted languages |
| Education | accepted degrees or fields |
| Headline | what their profile headline says |
| About | what their profile summary says |
| Estimated followers | accepted range |
| Network size | accepted range |

When the titles that define a persona are unstated, ask for them with options before writing it.

## Members

A member file is an identity record, not criteria: `- Email:` (required), then `- Role:`, `- Location:`,
`- Headline:`, `- About:` and `- Links:`, each `Unknown` until known. A member without an email is not added.

## Changing context

- When a new ICP or persona overlaps an existing one, offer to update that one first.
- When a workflow reads a file being changed, say its next run uses the change and rows it already scored keep
  their scores until they are rescored. Deleting a file a workflow reads makes its runs fail until it reads another;
  say so before deleting (docs: interaction, rule 4).
