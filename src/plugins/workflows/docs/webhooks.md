# Webhooks

Inbound webhooks (email replies, CRM events, form submissions) are declared in `webhooks/index.ts`, one entry per
sender, and served at `/api/revbound/hooks/<name>`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { webhook, type Webhooks } from "#revbound/workflows";

export const webhooks = {
  forms: webhook<{ id: string; email: string }>({
    // The sender's signature over the raw body, with its signing secret (a connection in .env.example).
    verify: (req, raw) => {
      const given = Buffer.from(req.headers.get("x-signature") ?? "");
      const want = Buffer.from(createHmac("sha256", process.env.FORMS_SIGNING_SECRET ?? "").update(raw).digest("hex"));
      return Boolean(process.env.FORMS_SIGNING_SECRET) && given.length === want.length && timingSafeEqual(given, want);
    },
    dedupe: (_req, body) => body.id,                        // the sender's event id
    onEvent: async ({ body, start }) => { await start("qualify-signup", { email: body.email }); },
  }),
} satisfies Webhooks;
```

## What happens on a delivery

1. `verify` checks the signature; false answers 401. Refuse when the signing secret is unset or is Vercel's pull
   placeholder `[SENSITIVE]`.
2. `dedupe` returns the sender's event id, claimed once in `revbound_workflows.webhook_events`. A repeat delivery
   answers 200 without calling `onEvent`.
3. `onEvent` records a row (through `db()`) or starts a registered workflow with `start`; all other work happens in
   the run. It may return `"ignored"` for events it does not handle. If it throws, the claim is released and the
   route answers 500, so the sender retries.
4. `start` never starts a workflow that needs approval: a webhook cannot carry a person's yes.

## The sender's URL

- Production: `https://<production domain>/api/revbound/hooks/<name>`, carrying that sender's own labeled Vercel bypass
  secret as the `x-vercel-protection-bypass` header or, when the sender cannot set headers, the query parameter. It
  passes Vercel Authentication with no protection exception.
- Create one bypass secret per sender in Project Settings → Deployment Protection → Protection Bypass for Automation,
  labeled with the sender's name, so it can be revoked alone. Store the same value as the Production variable
  `REVBOUND_HOOK_<NAME>_BYPASS` (the name upper-cased, `-` as `_`; `REVBOUND_HOOK_FORMS_BYPASS` above), then redeploy.
  That route accepts only that secret; every other route, page and console read refuses it.
- Never give a sender the automation secret (`VERCEL_AUTOMATION_BYPASS_SECRET`): webhook routes refuse it.

## Locally

`/api/revbound/hooks/<name>` answers on `127.0.0.1`/`localhost` only. Send a test delivery with `curl`, signed the way
the sender signs.
