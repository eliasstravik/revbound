// Inbound webhooks: { <name>: webhook({ verify, dedupe, onEvent }) }, served at /api/revbound/hooks/<name>
// (`npx revbound docs webhooks`).
import type { Webhooks } from "revbound/workflows";

export const webhooks = {} satisfies Webhooks;
