# console

The console's frame: the sidebar from every plugin's nav items, the page that shows the matching view, the 404. Read and navigation only. Its budget also counts the shared UI kit (`src/ui`).

- Line budget: 500 lines of TypeScript (`npm run lines` in the revbound repository), reviewed at every release.
- No commands or docs topics of its own.
- Eject it with `npx revbound eject console` to edit a copy in `plugins/console/`; `npx revbound diff console` shows upstream changes.
