# Agent

The `agent` plugin is the project's own chat agent: one [eve](https://www.npmjs.com/package/eve) agent in the company's
project that works on it the way a teammate's coding agent would. It reads `AGENTS.md`, `context/` and the company's
skills, writes and changes workflows, starts runs through the ledger after the asker's own yes, reads runs, and
proposes changes. People reach it from the console's **Chat** page and, once added, from chat apps
(each an eve channel on the same agent). It is a default plugin: `revbound init` adds `agent()` and its Chat page.

```ts
agent()                                         // the console's Chat page
agent({ channels: ["console", "slack"] })       // plus Slack (`npx revbound agent add slack` writes this)
agent({ model: "anthropic/claude-opus-5.5" })   // another AI Gateway model for the chat
```

## What it is made of

`revbound sync` writes `agent/`, eve's agent folder, from the plugin's options; never edit it. Each file loads the
agent from `revbound/agent`: its instructions, the console channel (`channels/eve.ts`), the chat apps you added, its
sandbox, `start_run` and `run_status`, eve's `glob` and `grep`, and eve's git extension for pull requests
(`git__gh`). `agent/skills` links to `.agents/skills`, so every company skill is an eve skill; that folder must hold only
skill folders, each with a `SKILL.md` whose front matter has a `description` (`revbound check` says when one does not).

| | On a laptop (`npm run dev`) | Deployed |
| --- | --- | --- |
| Where it runs | eve's dev server on 127.0.0.1, started by `revbound dev`; the app proxies `/eve/v1/*` to it | its own eve service in the same Vercel project, routed at `/eve/v1/*` |
| Its model | `REVBOUND_CHAT_MODEL` or AI Gateway when set up, else an API key, else your signed-in `codex` or `claude` (following `REVBOUND_AGENT_BACKEND`): Claude Haiku 5.5 for claude, GPT-6 Sol for codex, or `model` / `REVBOUND_CHAT_MODEL` | AI Gateway through the deployment's OIDC: Claude Haiku 5.5 when `REVBOUND_AGENT_BACKEND=claude`, GPT-6 Sol for codex, or `model` / `REVBOUND_CHAT_MODEL` |
| Its workspace | the project folder itself, through eve's just-bash shell: edits land in your files. Files that hold keys or local data are hidden. Files that run on their own under `npm run dev` (`revbound.config.ts`, `package.json`, `plugins/`, `app/`, …) are read-only to it, and it runs nothing on your computer (no node, no git), so you run `npx revbound check`. Its edits to `workflows/` go live in `npm run dev` like any coding agent's: review them with `git diff` before you say yes to a run | a Vercel Sandbox made at build time from the deployed commit (no keys, no build output), with npm packages installed and `npx revbound check` working; it reaches only GitHub and the npm registry |
| A change | edits in your working tree; review them with `git diff` | a draft pull request on a `revbound/<name>` branch, never onto main |
| A run | `start_run` against `revbound dev` on 127.0.0.1 | `start_run` against the deployment's own API with the automation bypass secret |

## Deploying it

`vercel.json` deploys the app and the agent as two services of the one Vercel project and sends `/eve/v1/*` to the
agent; the starter has these keys, and `revbound check` prints them when they are missing or changed:

```json
"services": {
  "web": { "root": ".", "framework": "nextjs" },
  "eve": { "root": "agent", "framework": "eve", "outputDirectory": ".vercel/output", "buildCommand": "cd .. && …" }
},
"rewrites": [
  { "source": "/eve/v1/(.*)", "destination": { "service": "eve" } },
  { "source": "/(.*)", "destination": { "service": "web" } }
]
```

The Vercel project's Framework Preset must be **Services** (Project Settings → Build and Deployment); with another
preset only one of the two is built. The agent's workspace is prepared during the build, once per deployment.

## Who can use it

- **Console Chat**: exactly the console's access rule. Deployed, a person past Vercel Authentication, with no bypass
  credential of any kind, on a deployment where Vercel Authentication is on; each Vercel login is its own person.
  Locally, the computer running `npm run dev`, or a Tailscale login on one of its `REVBOUND_ALLOWED_HOSTS` (the chat
  runs on this computer's own AI login, so a private hostname alone is not enough). Writes must come from the console's
  own page. Nothing else opens `/eve/v1/session`: no Vercel OIDC token, bypass secret or eve login.
- **Slack**: full members of the company's own workspace (or its Enterprise Grid org) only. Guests, bots, deactivated
  accounts and Slack Connect (shared) channels are refused, every Slack API error refuses, and "the company" is the bot's
  own `auth.test` team, never the event's.
- **Teams**: people of the company's own Microsoft tenant (`MICROSOFT_TENANT_ID`; unset refuses everyone).

## The Chat page

- **Files and photos**: add them with **+**, by pasting or by dropping them on the chat, or take a screenshot (desktop).
  They go to the agent with your message, up to about 3 MB in all per message; it reads photos and PDFs directly and
  other files from its workspace.
- **Ask or Edit** (in **+**): in Ask mode the agent only answers that turn; it changes no files and starts no runs.
- **Talk to type** (the microphone): what you say is written into the box when you tap ✓, for you to check and send.
- **Voice call** (the wave button, when the box is empty): talk to the agent hands-free. Each time you pause, what you
  said is sent as your message; the agent's reply, and any yes it needs, is read out. Talking while it speaks cuts it
  off. A spoken "yes" is never an approval: tap Approve.

Voice goes through AI Gateway: deployed, with the deployment's own OIDC, so it needs no key; on a laptop, after
`vercel env pull` (or with `AI_GATEWAY_API_KEY`). It uses `openai/gpt-4o-mini-transcribe` to write out speech and
`openai/tts-1` to read replies, both billed to the team's AI Gateway credits. It answers exactly the people the chat
does (`/eve/v1/voice`). AI Gateway's live streaming and realtime voice take a Gateway API key, not OIDC, so voice
waits for each pause instead of writing words out as you speak.

## The yes

`start_run` follows the ledger's own flow (docs: ledger). Deployed, a preview runs at once, capped by the ledger; on a
laptop a preview waits for a yes too, because it runs code the agent may just have edited, with the laptop's keys. A
real run always first shows the person who asked an approval request with the workflow, the cost cap and a one-line summary; only that
person can approve or cancel it (code, not the model, checks it: anyone else's click is refused and the request stays
open), and a "yes" typed in the chat is not an approval. After the yes the run starts with `approve: { maxUsd, note }`,
so the ledger records the cap and "Yes in chat from <person>" and still refuses an approval-required workflow without
a completed preview of the same input. The agent cannot start runs any other way: `revbound run` does not work from its
shell.

## Keys

The agent never sees a key. Its sandbox gets none; the bypass secret that starts runs stays in the agent's own server
process; GitHub's token is added at the sandbox firewall for one command at a time. Chat-app keys
(`SLACK_BOT_TOKEN`, …) are Production variables set with `vercel env add … --sensitive`.

## Pull requests (deployed)

A deployed agent proposes repo changes as draft pull requests through a Vercel Connect GitHub connector named
`revbound`. Until it exists the chat still works and the agent says this one step:

```sh
vercel connect create github --name revbound    # in the project folder; finish in the browser and install the
                                                # GitHub app on this project's repository only
```

The project's Vercel Git connection names the repository. `git__gh` runs reads, fetches, pull-request commands and
commits or pushes to `revbound/<name>` branches only; merging, pushing anywhere else, deleting and settings are refused.

## Add Slack

```sh
npx revbound agent add slack     # sets agent({ channels: ["console", "slack"] }), syncs, prints the steps below
```

Then, once, by a person:

1. Vercel → the project → Settings → Deployment Protection → Protection Bypass for Automation: add a secret just for
   Slack (note "slack"). Never reuse the one laptops use.
2. <https://api.slack.com/apps> → Create New App → From a manifest: paste the manifest `agent add slack` printed, with
   `<Slack's bypass secret>` replaced by that secret in both URLs
   (`https://<production domain>/eve/v1/slack?x-vercel-protection-bypass=<secret>`).
3. Install the app to the workspace, then `vercel env add SLACK_BOT_TOKEN production --sensitive` (Bot User OAuth Token)
   and `vercel env add SLACK_SIGNING_SECRET production --sensitive` (Basic Information).
4. Commit and push, so the deployment has the Slack channel. Invite the app to a channel and mention it, or DM it.

Slack's signature check and the member check are the Slack route's guards; the bypass in its URL only gets Slack's
requests past Vercel's login (Vercel Connect's Slack triggers need a Deployment Protection Exception, which Revbound
never allows). `npx revbound agent status` lists the channels and which keys this computer lacks;
`npx revbound agent remove slack` turns it off again.

## Other chat apps

`npx revbound agent add teams` works the same way for Microsoft Teams (an Azure Bot, single tenant, its own bypass
secret in the messaging endpoint, `MICROSOFT_APP_ID`, `MICROSOFT_APP_PASSWORD`, `MICROSOFT_TENANT_ID`). Other eve
channels can join the same way in a later version.

## When something is off

| Symptom | Fix |
| --- | --- |
| Chat says the agent is not answering, locally | keep `npm run dev` running; its log lines start with `[agent]` |
| `claude is not on PATH` | sign in to `claude` or `codex`, or set an API key (`npx revbound connections set ANTHROPIC_API_KEY`) |
| Deployed, a run fails with "Protection Bypass for Automation" | turn it on and expose system environment variables, then redeploy (docs: deploy) |
| The agent says GitHub is not connected | the one step under Pull requests |
| A build fails in eve's compile about `.agents/skills` | keep only skill folders there (`npx revbound check`) |
| Voice says it needs AI Gateway, locally | `vercel env pull` (or set `AI_GATEWAY_API_KEY`), then restart `npm run dev` |
| Voice says to allow the microphone | allow it for the site in the browser's address bar, then try again |
