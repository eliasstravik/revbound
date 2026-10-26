---
name: revbound
description: Sets up and maintains a company's go-to-market (GTM) project built on Revbound, the open-source agent plugin that runs GTM work. The project is one Next.js repo and Vercel project named after the company (revbound-acme for Acme) whose revbound.config.ts lists its plugins, with the company's context, workflows, ledger of runs and costs, console, chat agent and connections. Triggers when someone asks to set up GTM for a company ("set up GTM for Acme", "create revbound-acme"), to add or change the company's context, to build, preview, approve, run or schedule outbound, enrichment, scoring or other GTM workflows, to add, remove or write a plugin, to open the console, to add Slack to the project's chat agent, to add a connection or API key, to deploy the project to Vercel, and on any work inside a folder whose package.json depends on revbound. Not for unrelated web apps, marketing websites, generic Next.js projects, one-off CRM scripts outside a Revbound project, or changes to the revbound package itself.
---

# Revbound

## Trigger

Apply when a person asks to create, change, run or deploy a company's Revbound project, or works inside one.

## Scope

Owns one company's Revbound project, `revbound-<company>`, from `init` through every later change: context, workflows
and their approvals, plugins, the console and its chat agent, connections and deploy. Company know-how lives in that repo, never in this
skill, and this skill is never installed into it.

## Inputs

- The person's request and the company's name.
- The project's `AGENTS.md`; its managed block holds the rules of the installed version and its plugins.
- The installed docs: `npx revbound docs <topic>` inside the project (`npx revbound docs` outside one).

## Roles

- The coding agent edits the repo, runs the `revbound` CLI and does account steps with the vendors' own CLIs.
- The person decides what gets added, gives every yes in chat, and enters every secret value themselves
  (`npx revbound connections set <NAME>`, or `vercel env add` for live keys); never ask for a value in chat.

## Procedure

Talk by [the interaction rules](references/interaction.md); reproduce [the dialogues](references/interactions.md).

1. Find the project: the nearest folder at or above this one whose `package.json` depends on `revbound`.
2. With none, run `npx revbound init --company <Company>`, which creates `./revbound-<company>` here with
   `revbound.config.ts` (the eight default plugins, the chat agent included), base files only, installs and syncs; add `--example` only when the
   person asks for a demo. Run `init . --company <Company>` instead only when this folder is the project's own
   `revbound-<company>` folder and holds nothing but `.git`, `.agents/`, `.claude/`, `AGENTS.md` or `CLAUDE.md`. Then
   write only the basics into `context/company.md`: the name as its heading and a short description from what the person
   said, or a quick look at the company's site when they gave one. Ask what to add next and stop until they answer.
3. Otherwise read `AGENTS.md`, then the docs topic of the job before changing anything:

   | Job | Topics |
   | --- | --- |
   | Add or change context the person asked for | context |
   | Add or change a company skill (in `.agents/skills/<name>/SKILL.md` only) | layout |
   | Build, change or schedule a workflow | workflows, data, ai, recipes (copy one only when asked) |
   | Preview, approve or budget a run | ledger |
   | Add, remove, eject or write a plugin; add a page or an API route | plugins |
   | Open the console (`npm run dev`) or change project files | layout, local |
   | Add a connection or API key | connections |
   | Go live on Vercel | deploy, agent |
   | The console's Chat page (Claude Haiku 5.5 unless `agent({ model })` says otherwise); add Slack (`npx revbound agent add slack`, then the steps it prints) or Teams | agent |
   | Inbound webhooks | webhooks |
   | Keep people, companies or signals in one place, or enrich each record once (`npx revbound add mdm`) | mdm |

4. Company code imports plugins only as `#revbound/<plugin>` (`#revbound/database`, `#revbound/ai`,
   `#revbound/workflows`, `#revbound/ledger`). After changing `revbound.config.ts` or a local plugin, run
   `npx revbound sync`; never edit `_revbound/` or the shims.
5. Mark every workflow that spends money or acts on people `approval: { required: true }` with a `budget`. Before a real
   run of one: `npx revbound run <workflow> --input … --preview`, show the sample and the cost in this chat, ask Yes/No
   with the native question tool naming the workflow, the input and the cost cap, and only after a Yes run it with
   `--approve --max-usd <cap>`. A schedule's yes (cost per run × runs per month) is committed as
   `schedule: { approvedUntil, note }` in the same change that adds the cron to `vercel.json`. Never approve on your
   own.
6. Run `npx revbound check` and fix what it lists; `npx revbound init` inside the project restores missing wiring.

## Outputs

Changes in the company's `revbound-<company>` repo and, for deploy steps, its Vercel project of the same name.

## Exceptions

- `init` refuses a Next.js app that is not a Revbound project and a non-empty folder; offer a new `revbound-<company>`
  folder instead.
- A 403 that says "This workflow needs a person's yes" means step 5: preview, show, ask, then `--approve`.
- Where this file and the installed docs disagree, the docs win; they match the installed version.

## QC

- After setup, `context/` holds only `company.md` with the name and a short description until the person asks for more.
- Every AI call in a workflow is `agent()` from `#revbound/ai`: no `ai` or `@ai-sdk/*` import, no model id in company
  code (`REVBOUND_MODEL` picks it). Paid calls outside `agent()` go through `action()` from `#revbound/ledger`.
- Company code never imports `revbound/<plugin>` subpaths or `start` from `workflow/api`.
- A company skill is a folder in `.agents/skills/` with a `SKILL.md` (`name`, `description`), created there and not
  through `.claude/skills`.
- `npx revbound check` exits 0 after every change, and `check --prod` before a deploy is called live.
- No `--approve` without a Yes in this chat for that exact workflow, input and cap.

## References

[interaction](references/interaction.md) rules and [interactions](references/interactions.md) dialogues; the project's
`AGENTS.md`; `npx revbound docs [topic]`, where `context` holds the suggested context layout and `plugins` the plugin
contract.
