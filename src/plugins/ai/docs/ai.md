# AI steps

Every AI call in a workflow, one-shot or tool-using, is `agent()` from `#revbound/ai`: a one-shot extract, score or
draft is `agent()` without `tools`; research that picks its own tool calls is `agent()` with them. It picks the backend,
reserves each call's cost in the ledger, counts calls in previews and keeps keys out of the run log. Never import `ai`
or `@ai-sdk/*` in company code, and never write a model id there: `REVBOUND_MODEL` picks the model, and a stage's own
`model` is only for a stage that truly needs another one. Custom tools take `tool` from `#revbound/ai` too.
`npx revbound check` flags both.

```ts
import { z } from "zod";
import { agent } from "#revbound/ai";

const { value } = await agent({
  name: "draftEmail",
  instructions: "Draft the first cold email to this person.",
  skills: ["email-copywriting"], // .agents/skills/email-copywriting/SKILL.md
  prompt: JSON.stringify(person),
  schema: z.object({ subject: z.string(), body: z.string() }),
});
```

Options: `name`, `instructions`, `prompt`, `skills?` (folder names in `.agents/skills`, read in a step, so it works
hosted too), `schema?`, `model?`, `reasoning?`, `tools?` (`mcp`, `web`, `custom`), `maxSteps?` (default 20),
`maxOutputTokens?` (default 4,096, passed to the model), `maxUsd?`, `timeout?` (the CLI path; default `"10m"`). When
`maxSteps` or `maxUsd` cuts the loop short, one last call without tools writes up the result. It returns `{ value,
costUsd, modelCalls, toolCalls, usage, stopReason }`.

Call it in workflow scope only, never inside a `"use step"` body: every model call and tool call is its own step.

## Cost and limits

- Each model call reserves `ceil(prompt characters / 4)` × the input price + `maxOutputTokens` × the output price
  before it runs, and settles at the reported cost (AI Gateway) or the real token usage × price. Prices come from AI
  Gateway's model list on the Gateway path and from a dated table in the plugin on the provider-key path. A model with
  no known price needs `maxUsd` on the stage, which becomes its estimate; otherwise the call is refused.
- A refused call (a budget, an approval, a preview limit) ends the run with a `FatalError` carrying the ledger's
  reason; it is not retried. A preview that hits `previewCalls` says to size previews with `currentRun().preview`.
- Each retried attempt of a model call reserves and counts its own row.
- The local `claude`/`codex` path costs no dollars: each stage is one counted call, "plan usage, not metered".

## Backends

Hosted, `agent()` always uses AI Gateway (the deployment's OIDC token, or `AI_GATEWAY_API_KEY`), with every model and
tool call a step. On a laptop the first match wins, per call:

1. AI Gateway, when `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` is set. A pulled OIDC token expires; the error
   then says to run `vercel env pull` again.
2. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, through their AI SDK providers.
3. The headless `claude -p` or `codex exec` the person is already signed into: `REVBOUND_AGENT_BACKEND` (`claude` or
   `codex`; `init` writes it to `.env.local` for the agent that ran it), else whichever is on PATH, `claude`
   first. The whole stage runs as one step. MCP servers, web tools and skills carry over; custom tools need path
   1 or 2, and the error names the variables that enable them. The CLI gets only an allowlisted environment,
   never the app's secrets. A stage's `model` (else `REVBOUND_MODEL`) goes to the CLI when it is that CLI's family:
   `anthropic/…` as `claude --model`, `openai/…` as `codex -m`; any other model, or none, leaves the CLI on its
   own default. `reasoning` `none` and `minimal` run as `low` (neither CLI's default model has them).
   `maxSteps` does not apply.

`maxUsd` is a soft cap for the stage: after the call that reaches it, one last call without tools writes up the
result. On `claude` it is `--max-budget-usd`, which stops without a result, so the stage fails; `codex` has no cap. A
model call does not retry inside its step; the step's own retries do, and each attempt is reserved.

## Models

`REVBOUND_MODEL` wins. Otherwise the default follows `REVBOUND_AGENT_BACKEND`: `claude` → Claude Haiku 5.5, anything
else → GPT-6 Luna. Production gets the same variables, so hosted runs stay on that family (docs: deploy). Claude Haiku
5.5 is Gateway `anthropic/claude-haiku-5.5`, Anthropic `claude-haiku-5-5`; GPT-6 Luna is Gateway `openai/gpt-6-luna`,
OpenAI `gpt-6-luna`.

## Plan limits

The CLI path runs on the person's own subscription through the real, unmodified `claude`/`codex` binary and never
touches their login. Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page says
plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK", so big batch runs may hit plan limits;
`agent()` prints this once per process. For big runs set a provider key
(`npx revbound connections set ANTHROPIC_API_KEY`) or link Vercel for AI Gateway, which switches the CLI path off.
Cursor users without `claude` or `codex` on PATH need a provider key or AI Gateway for AI steps.
