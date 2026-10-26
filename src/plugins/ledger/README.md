# ledger

The `ledger` slot (`LedgerSlotV1`): every run Revbound admits or refuses, every metered action and its cost, approvals, budgets, `action()`, reconcile (with the hourly cron route), and the Runs view.

- Line budget: 750 lines of TypeScript (`npm run lines` in the revbound repository), reviewed at every release.
- Docs: `ledger`.
- Eject it with `npx revbound eject ledger` to edit a copy in `plugins/ledger/`; `npx revbound diff ledger` shows upstream changes.
