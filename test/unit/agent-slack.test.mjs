// The agent's Slack channel: Slack-signed requests go through eve's own Slack route handler (verification, parsing, hook
// routing) into the agent's hooks, which call a fake Slack Web API on 127.0.0.1. No real Slack (against the build).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { authTestGrid, conversations, ENTERPRISE, GRID_SISTER_TEAM, TEAM, users } from "../agent/fixtures.mjs";
import {
  approvalRequest, click, deliver, directMessage, eventBody, fakeSlack, mention, signed, slashCommand, threadReply,
} from "../agent/helpers.mjs";

const JSON_TYPE = "application/json";
const FORM = "application/x-www-form-urlencoded";
const dist = (file, instance) => import(new URL(`../../dist/plugins/agent/${file}.js${instance ? `?${instance}` : ""}`, import.meta.url).href);
let slack, channel, requesterOnly;

before(async () => {
  slack = await fakeSlack();
  channel = (await dist("eve/slack")).default;
  ({ requesterOnly } = await dist("approval"));
});
after(() => slack?.close());

const send = (body, type = JSON_TYPE, options) => deliver(channel, signed(body, type), options);

test("a mention from a full member starts a turn as that member", async () => {
  const { status, sends } = await send(mention("U0MEMBER01", "C0PUBLIC01"));
  assert.equal(status, 200);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].options.auth.principalId, `slack:${TEAM}:U0MEMBER01`);
  assert.equal(slack.calls("users.info").at(-1).params.user, "U0MEMBER01");
  assert.equal(slack.calls("conversations.info").at(-1).params.channel, "C0PUBLIC01");
});

test("mentions from a guest, single-channel guest, bot, deleted or external user are refused", async () => {
  for (const user of ["U0GUEST001", "U0SINGLE01", "U0BOTUSER1", "U0DELETED1", "U0EXTERNAL", "U0MISSING1"]) {
    const { status, sends } = await send(mention(user, "C0PUBLIC01"));
    assert.equal(status, 200, user);
    assert.equal(sends.length, 0, user);
  }
});

test("a member's mention in a Slack Connect or pending Slack Connect channel is refused", async () => {
  for (const conversation of ["C0CONNECT1", "C0PENDING1"]) assert.equal((await send(mention("U0MEMBER01", conversation))).sends.length, 0, conversation);
});

test("the company is the bot's own auth.test team, not the event envelope's, read once", async () => {
  const { sends } = await send(eventBody({ type: "app_mention", user: "U0EXTERNAL", channel: "C0PUBLIC01", text: "<@U0BOT00001> hi", ts: "1760000999.000100" }, "T0OTHER001"));
  assert.equal(sends.length, 0);
  assert.equal(slack.calls("auth.test").length, 1);
});

test("Slack API errors refuse (fail closed), and it works again once Slack answers", async () => {
  slack.state.fail["users.info"] = true;
  try { assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 0); } finally { delete slack.state.fail["users.info"]; }
  slack.state.fail["conversations.info"] = "missing_scope";
  try { assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 0); } finally { delete slack.state.fail["conversations.info"]; }
  assert.equal((await send(mention("U0MEMBER01", "C0PUBLIC01"))).sends.length, 1);
});

test("DMs: a member is admitted, a guest is refused", async () => {
  assert.equal((await send(directMessage("U0MEMBER01"))).sends.length, 1);
  assert.equal((await send(directMessage("U0GUEST001"))).sends.length, 0);
});

test("unmentioned thread replies count only in a thread the agent works in, and only from members", async () => {
  const thread = "1760000500.000100", subscribed = [thread];
  assert.equal((await send(threadReply("U0MEMBER01", "C0PUBLIC01", thread))).sends.length, 0, "not subscribed");
  assert.equal((await send(threadReply("U0MEMBER01", "C0PUBLIC01", thread), JSON_TYPE, { subscribed })).sends.length, 1);
  assert.equal((await send(threadReply("U0GUEST001", "C0PUBLIC01", thread), JSON_TYPE, { subscribed })).sends.length, 0);
  assert.equal((await send(threadReply("U0MEMBER01", "C0CONNECT1", thread), JSON_TYPE, { subscribed })).sends.length, 0);
});

test("a request with a bad or old signature never reaches a hook", async () => {
  const before = slack.state.calls.length;
  const bad = await deliver(channel, signed(mention("U0MEMBER01", "C0PUBLIC01"), JSON_TYPE, { secret: "wrong" }));
  assert.equal(bad.status, 401);
  assert.equal(bad.sends.length, 0);
  assert.equal((await deliver(channel, signed(mention("U0MEMBER01", "C0PUBLIC01"), JSON_TYPE, { age: 3600 }))).status, 401);
  assert.equal(slack.state.calls.length, before, "no Slack API call for unsigned traffic");
});

test("approval clicks: the requester's yes is delivered, another member's is refused by the tool's policy", async () => {
  const thread = "1760000600.000100";
  const requester = (await send(mention("U0MEMBER01", "C0PUBLIC01", { ts: thread }))).sends[0].options.auth;
  const request = approvalRequest("start_run", { workflow: "enrich", preview: false, maxUsd: 5, summary: "5 rows, about $0.04" });
  const own = await send(await click(request, "approve", "U0MEMBER01", "C0PUBLIC01", thread), FORM);
  assert.equal(own.responds.length, 1);
  assert.deepEqual(own.responds[0].responses, [{ optionId: "approve", requestId: request.requestId }]);
  assert.deepEqual(await requesterOnly({ request: { principal: requester }, response: { decision: "approve", principal: own.responds[0].options.auth } }), { status: "allowed" });
  const other = await send(await click(request, "approve", "U0MEMBER02", "C0PUBLIC01", thread), FORM);
  assert.equal(other.responds.length, 1, "another member's click reaches eve...");
  for (const decision of ["approve", "cancel"]) {
    const verdict = await requesterOnly({ request: { principal: requester }, response: { decision, principal: other.responds[0].options.auth } });
    assert.equal(verdict.status, "rejected", `...and the tool's policy refuses its ${decision}, so the request stays open`);
  }
  assert.equal((await requesterOnly({ request: { principal: null }, response: { decision: "approve", principal: requester } })).status, "rejected", "an anonymous request has no requester");
});

test("approval clicks from a guest, another organization or a Slack Connect channel never reach eve", async () => {
  const request = approvalRequest("start_run", { workflow: "enrich", preview: false, maxUsd: 5, summary: "x" });
  assert.equal((await send(await click(request, "approve", "U0GUEST001", "C0PUBLIC01", "1760000700.000100"), FORM)).responds.length, 0);
  assert.equal((await send(await click(request, "approve", "U0EXTERNAL", "C0PUBLIC01", "1760000700.000100", "T0OTHER001"), FORM)).responds.length, 0);
  assert.equal((await send(await click(request, "approve", "U0MEMBER01", "C0CONNECT1", "1760000700.000100"), FORM)).responds.length, 0);
});

test("slash commands, shortcuts and other events run the member check and start nothing, for anyone", async () => {
  for (const user of ["U0MEMBER01", "U0GUEST001"]) {
    const posts = slack.calls("chat.postMessage").length;
    const inputs = [
      [slashCommand(user, "C0PUBLIC01"), FORM],
      [`payload=${encodeURIComponent(JSON.stringify({ type: "shortcut", callback_id: "revbound", trigger_id: "1.2.3", user: { id: user, team_id: TEAM }, team: { id: TEAM } }))}`, FORM],
      [eventBody({ type: "member_joined_channel", user, channel: "C0PUBLIC01", channel_type: "C" }), JSON_TYPE],
    ];
    for (const [body, type] of inputs) {
      const before = slack.calls("users.info").length;
      const result = await send(body, type);
      assert.equal(result.status, 200);
      assert.equal(result.sends.length + result.responds.length, 0);
      assert.equal(slack.calls("users.info").length, before + 1, `the member check ran for ${user}: ${body.slice(0, 40)}`);
    }
    assert.equal(slack.calls("chat.postMessage").length, posts, "nothing posted");
  }
});

/** A Slack handle answering from the fixtures, recording each method; `fail` maps a method to an error or "throw". */
function api({ auth = { ok: true, team_id: TEAM }, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, body) {
      calls.push(method);
      if (fail[method] === "throw") throw new Error("network");
      if (fail[method]) return { ok: false, error: fail[method] };
      if (method === "auth.test") return auth;
      if (method === "users.info") return users[body.user] ?? { ok: false, error: "user_not_found" };
      return conversations[body.channel] ?? { ok: false, error: "channel_not_found" };
    },
  };
}

test("isMember and isInternal: full members only; Slack Connect refused; Grid sister workspaces admitted", async () => {
  const { isInternal, isMember } = await dist("members");
  const company = { teamId: TEAM };
  assert.equal(isMember(users.U0MEMBER01.user, company), true);
  for (const id of ["U0GUEST001", "U0SINGLE01", "U0BOTUSER1", "U0DELETED1", "U0EXTERNAL"]) assert.equal(isMember(users[id].user, company), false, id);
  const { is_restricted: _, ...noFlag } = users.U0MEMBER01.user;
  assert.equal(isMember(noFlag, company), false, "a missing guest flag refuses");
  const grid = { teamId: TEAM, enterpriseId: ENTERPRISE };
  assert.equal(isMember(users.W0GRIDSIS1.user, grid), true, `member of ${GRID_SISTER_TEAM} in the same grid`);
  assert.equal(isMember(users.W0GRIDOTH1.user, grid), false, "other enterprise");
  for (const id of ["C0PUBLIC01", "G0PRIVATE1", "C0ORGSHARE", "D0DIRECT01"]) assert.equal(isInternal(conversations[id].channel), true, id);
  for (const id of ["C0CONNECT1", "C0PENDING1"]) assert.equal(isInternal(conversations[id].channel), false, id);
});

test("allowed: every Slack API failure refuses, a failed auth.test is not cached, Grid installs admit sister workspaces", async () => {
  const { allowed } = await dist("members", "failures");
  assert.equal(await allowed(api({ fail: { "auth.test": "invalid_auth" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(api({ fail: { "users.info": "throw" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(api({ fail: { "conversations.info": "missing_scope" } }), "U0MEMBER01", "C0PUBLIC01"), false);
  assert.equal(await allowed(api(), undefined, "C0PUBLIC01"), false, "no user id");
  assert.equal(await allowed(api(), "U0MEMBER01", "C0PUBLIC01"), true, "recovers once Slack answers");
  const fresh = await dist("members", "grid");
  const gridApi = api({ auth: authTestGrid });
  assert.equal(await fresh.allowed(gridApi, "W0GRIDSIS1", "C0ORGSHARE"), true);
  assert.equal(await fresh.allowed(gridApi, "W0GRIDOTH1", "C0ORGSHARE"), false);
  assert.equal(gridApi.calls.filter((m) => m === "auth.test").length, 1, "auth.test is read once per instance");
});
