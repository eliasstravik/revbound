# connections

Connections are environment variables: the Connections view, which adds, edits and deletes keys locally and on the production domain, and `revbound connections list | set | delete` for local keys.

- Line budget: 700 lines of TypeScript (`npm run lines` in the revbound repository), reviewed at every release.
- Commands and docs: `revbound connections`; docs: `connections`.
- Eject it with `npx revbound eject connections` to edit a copy in `plugins/connections/`; `npx revbound diff connections` shows upstream changes.
