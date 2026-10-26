# agent

The project's chat agent: one eve agent in the company's own project, reached from the console's Chat page and from chat
apps (eve channels: Slack, Teams). It reads the project, changes workflows (local edits on a laptop, pull requests when
deployed) and starts runs through the ledger after the asker's own yes (docs: agent).

- Line budget: 1,400 lines of TypeScript (`npm run lines` in the revbound repository), reviewed at every release.
- Command: `revbound agent [status] | add <channel> | remove <channel>`. Docs topic: `agent`.
- Writes `agent/` (eve's agent folder) through sync's plugin `files`; `agent/skills` links to `.agents/skills`.
