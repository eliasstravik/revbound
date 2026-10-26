# Revbound

The `revbound` package, its starter, docs, skill and plugin manifests (README.md). `starter/AGENTS.md` is
the template companies get, not instructions for this repo.

## Public repo

This repo and everything around it is public: files, commit messages, branch and tag names, pull request titles,
descriptions and comments, reviews, issues, releases and CI logs. Never put any of these in them:

- secrets: keys, tokens, passwords, bypass or webhook secrets, connection strings with credentials;
- real hostnames and URLs of private machines or deployments: Tailscale names (`*.ts.net`) and addresses
  (CGNAT `100.x`), private IPs, `*.vercel.app` deployments, VM names, preview links;
- email addresses: every commit's author and committer is a GitHub noreply address, which CI enforces. On this
  machine that is the repo's `git config user.email` (`218792529+eliasstravik@users.noreply.github.com`, shared by every
  worktree; never override it per worktree or with `GIT_AUTHOR_EMAIL`). A merge on GitHub gets the account's
  email unless "Keep my email addresses private" is on, so merge with
  `gh pr merge --squash --author-email 218792529+eliasstravik@users.noreply.github.com`. A workflow that commits sets
  `github-actions[bot]` and `41898282+github-actions[bot]@users.noreply.github.com` (none does today). Trailers use
  `noreply` addresses;
- customer or company data: names, ICPs, personas, leads, pipeline, run results, Slack, Vercel or GitHub IDs of a
  real workspace;
- local paths (home folders on Linux, macOS or Windows) and links to local reports or files.

Use placeholders instead: Acme, `example.com`, `box.tail1234.ts.net`, `gtm-acme.vercel.app`, `U0MEMBER01`. Anything
private for a reviewer goes in the task's private report, never in the pull request. CI's privacy check
(`.github/workflows/privacy.yml`, rules in `.github/private-data.toml`) fails the build on the patterns it can see;
company data it cannot, so this rule still holds where the check is silent.

## Console copy

Console text (`src/ui`) only helps the user act: labels, empty states, errors with their fix. Never explain how it
works inside: no file names, where things are stored, what is never shown, or why it is built that way.
