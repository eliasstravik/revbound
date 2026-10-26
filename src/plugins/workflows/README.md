# workflows

The `workflows` slot (`WorkflowsSlotV1`) on the Workflow SDK: the registry and webhooks, the single start path through the ledger, `fanOut()`, `webhook()`, `currentRun()`, crons, the Workflows views and the local run inspector.

- Line budget: 900 lines of TypeScript (`npm run lines` in the revbound repository), reviewed at every release.
- Commands and docs: `revbound run`; docs: `workflows`, `webhooks`.
- Eject it with `npx revbound eject workflows` to edit a copy in `plugins/workflows/`; `npx revbound diff workflows` shows upstream changes.
