// Test kit for the agent's chat apps: a fake Slack Web API on 127.0.0.1, Slack-signed requests, and a direct call into
// eve's real Slack route handler (the agent's channel from the build) with a session context that records what the
// channel dispatched. No real Slack.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { authTest, BOT_USER, conversations, TEAM, users } from "./fixtures.mjs";

export const SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.EVE_LOG_LEVEL = "error";

/** Warnings logged during the run (the member check logs each fail-closed refusal); kept off the test output. */
export const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));

// Every outbound fetch to a mapped origin goes to a local server instead; everything else is refused.
const routes = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  for (const [from, to] of routes) {
    if (!url.startsWith(from)) continue;
    const target = to + url.slice(from.length);
    return input instanceof Request ? realFetch(new Request(target, input), init) : realFetch(target, init);
  }
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
  throw new Error(`test network: refused ${url}`);
};

/**
 * A fake Slack Web API answering from the recorded fixtures; slack.com/api/* is routed to it. `state.auth` is the
 * auth.test body, `state.fail[method]` forces an HTTP 500 (or an `{ ok: false }` body when it is a string).
 */
export async function fakeSlack(auth = authTest) {
  const state = { auth, fail: {}, calls: [] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const method = req.url.replace(/^\/api\//, "").split("?")[0];
    const params = Object.fromEntries(new URLSearchParams(raw));
    state.calls.push({ method, params });
    const failure = state.fail[method];
    const [status, body] = failure === true ? [500, { ok: false, error: "internal_error" }]
      : typeof failure === "string" ? [200, { ok: false, error: failure }]
      : method === "auth.test" ? [200, state.auth]
      : method === "users.info" ? [200, users[params.user] ?? { ok: false, error: "user_not_found" }]
      : method === "conversations.info" ? [200, conversations[params.channel] ?? { ok: false, error: "channel_not_found" }]
      : method === "conversations.replies" ? [200, { ok: true, messages: [], has_more: false }]
      : [200, { ok: true, ts: "1760000000.000900", channel: params.channel }];
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  routes.set("https://slack.com/api/", `http://127.0.0.1:${port}/api/`);
  return { state, url: `http://127.0.0.1:${port}/api/`, close: () => new Promise((r) => server.close(r)), calls: (method) => state.calls.filter((c) => c.method === method) };
}

/** A request Slack would send to /eve/v1/slack, signed with the test signing secret (optionally a wrong one). */
export function signed(body, contentType, { secret = SIGNING_SECRET, age = 0 } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000) - age);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://revbound-acme.vercel.app/eve/v1/slack?x-vercel-protection-bypass=slack-own-secret", {
    method: "POST", body,
    headers: { "content-type": contentType, "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  });
}

let sequence = 0;
const ts = () => `1760000${String(++sequence).padStart(3, "0")}.000100`;

/** An Events API callback around `event`. */
export function eventBody(event, team = TEAM) {
  return JSON.stringify({
    token: "unused", team_id: team, api_app_id: "A0ACME0001", type: "event_callback", event_id: `Ev${Date.now()}${++sequence}`,
    event_time: Math.floor(Date.now() / 1000), authorizations: [{ team_id: TEAM, user_id: BOT_USER, is_bot: true, is_enterprise_install: false }],
    event: { team, event_ts: ts(), ...event },
  });
}

export const mention = (user, channel, extra = {}) =>
  eventBody({ type: "app_mention", user, channel, text: `<@${BOT_USER}> run the weekly enrichment`, ts: ts(), ...extra });
export const directMessage = (user, channel = "D0DIRECT01") =>
  eventBody({ type: "message", channel_type: "im", user, channel, text: "what ICPs do we have?", ts: ts() });
export const threadReply = (user, channel, threadTs) =>
  eventBody({ type: "message", channel_type: "channel", user, channel, text: "and the second list too", ts: ts(), thread_ts: threadTs });

/** A block_actions payload clicking `optionId` on eve's own rendered approval card for `request`. */
export async function click(request, optionId, user, channel, threadTs, team = TEAM) {
  const { renderInputRequestBlocks } = await import("eve/channels/slack");
  const blocks = renderInputRequestBlocks(request);
  const button = blocks.flatMap((b) => b.elements ?? b.actions ?? []).find((e) => e.value === optionId);
  const payload = {
    type: "block_actions", api_app_id: "A0ACME0001", trigger_id: "1.2.3",
    user: { id: user, username: user.toLowerCase(), team_id: team }, team: { id: team, domain: "acme" },
    channel: { id: channel, name: "gtm" }, container: { type: "message", channel_id: channel, message_ts: ts() },
    message: { type: "message", ts: ts(), thread_ts: threadTs, blocks },
    actions: [{ type: "button", action_id: button.action_id, block_id: "approval", value: button.value, text: { type: "plain_text", text: button.text.text }, action_ts: "1760000000.1" }],
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

export const slashCommand = (user, channel) => new URLSearchParams({
  token: "unused", team_id: TEAM, team_domain: "acme", channel_id: channel, channel_name: "gtm", user_id: user,
  user_name: user.toLowerCase(), command: "/revbound", text: "run enrichment", api_app_id: "A0ACME0001",
  is_enterprise_install: "false", response_url: "https://hooks.slack.com/commands/T/1/x", trigger_id: "1.2.3",
}).toString();

/** A tool-approval request as eve's runtime emits it for `toolName`. */
export const approvalRequest = (toolName, input) => ({
  requestId: `req_${++sequence}`, kind: "tool-approval", prompt: `Approve ${toolName}?`, display: "confirmation",
  options: [{ id: "approve", label: "Approve", style: "primary" }, { id: "cancel", label: "Cancel" }],
  action: { kind: "tool-call", callId: `call_${sequence}`, toolName, input },
});

/**
 * Calls the channel's POST /eve/v1/slack route the way eve's host does, with a session context that records what the
 * channel dispatched (`sends`: new turns, `responds`: HITL answers). Waits for the handler's background work.
 */
export async function deliver(channel, request, { subscribed = [] } = {}) {
  const handler = channel.routes.find((r) => r.method === "POST" && r.path === "/eve/v1/slack").handler;
  const pending = [], sends = [], responds = [];
  const source = (address) => ({
    send: async (message, options) => (sends.push({ address, message, options }), { id: "wrun_test" }),
    respond: async (responses, options) => (responds.push({ address, responses, options }), { status: "accepted" }),
    cancel: async () => ({ status: "no_active_turn" }), compact: async () => ({}), clear: async () => ({}), reset: async () => ({}),
  });
  const response = await handler(request, {
    waitUntil: (p) => pending.push(p),
    from: source,
    resolveSession: async (address) => (subscribed.some((s) => address.includes(s)) ? { id: "wrun_existing" } : undefined),
  });
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return { status: response.status, sends, responds };
}
