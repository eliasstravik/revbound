// The Console's shared words: relative times, statuses, schedules, key names, and how a run's reason is worded.
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ago, byFolder, cronWords, isActive, keyName, needsLook, statusOf } from "../../dist/ui/words.js";
import { refusal, splitReason } from "../../dist/plugins/ledger/words.js";

test("ago: just now, minutes, hours, days", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  assert.equal(ago("2026-11-12T11:59:30Z", now), "just now");
  assert.equal(ago("2026-11-12T11:48:00Z", now), "12m ago");
  assert.equal(ago("2026-11-12T07:00:00Z", now), "5h ago");
  assert.equal(ago("2026-11-09T12:00:00Z", now), "3d ago");
});

test("statusOf: one word list for the ledger's and the engine's statuses", () => {
  assert.deepEqual(statusOf("refused"), { word: "Not started", tone: "amber" });
  assert.deepEqual(statusOf("start_failed"), { word: "Not started", tone: "amber" });
  assert.deepEqual(statusOf("admitted"), { word: "Starting", tone: "running" });
  assert.deepEqual(statusOf("failed"), { word: "Failed", tone: "failed" });
  assert.deepEqual(statusOf("completed"), { word: "Completed", tone: "ok" });
  assert.deepEqual(statusOf("paused"), { word: "Paused", tone: "muted" });
  assert.ok(isActive("admitted") && isActive("running") && !isActive("refused"));
  assert.ok(needsLook("failed") && needsLook("start_failed") && !needsLook("refused") && !needsLook(null));
});

test("cronWords: common schedules in words, the rest as Custom schedule with the expression", () => {
  const now = new Date("2026-11-12T12:00:00Z"), words = (c) => cronWords(c, now).text;
  assert.equal(words("*/15 * * * *"), "Every 15 minutes");
  assert.equal(words("0 * * * *"), "Every hour");
  assert.equal(words("30 * * * *"), "Every hour at :30");
  assert.equal(words("0 */6 * * *"), "Every 6 hours");
  assert.equal(words("0 7 * * *"), "Daily 07:00");
  assert.equal(words("0 7 * * 1"), "Mondays 07:00");
  assert.equal(words("0 7 * * 7"), "Sundays 07:00");
  assert.equal(words("30 6 * * 1-5"), "Weekdays 06:30");
  assert.equal(words("0 8 1 * *"), "Monthly on the 1st, 08:00");
  assert.equal(words("0 8 22 * *"), "Monthly on the 22nd, 08:00");
  assert.deepEqual(cronWords("0 7 * * 1", now), { text: "Mondays 07:00", title: "Mondays 07:00 UTC" });
  for (const custom of ["0 7 * 3 *", "0 7,19 * * *", "0 7 * * 1,3", "nonsense"]) assert.deepEqual(cronWords(custom, now), { text: "Custom schedule", title: custom });
});

test("keyName: a key's friendly name from its variable", () => {
  assert.equal(keyName("FIRECRAWL_API_KEY"), "Firecrawl");
  assert.equal(keyName("HUBSPOT_ACCESS_TOKEN"), "HubSpot");
  assert.equal(keyName("SLACK_BOT_TOKEN"), "Slack");
  assert.equal(keyName("MY_CRM_URL"), "My CRM URL");
  assert.equal(keyName("TOKEN"), "Token");
});

test("splitReason: the message without the step path, the step's short name and its tries", () => {
  assert.deepEqual(splitReason('Step "step//./workflows/extra//boom" failed after 3 retries: HubSpot answered 401: the token was revoked.'),
    { message: "HubSpot answered 401: the token was revoked.", step: "boom", tries: 3 });
  assert.deepEqual(splitReason("The run did not start: no world"), { message: "The run did not start: no world" });
});

test("refusal: the ledger's refusals in a person's words, with the next step in Chat", async () => {
  const { NEEDS_YES } = await import("../../dist/plugins/ledger/provide.js");
  const plain = refusal(NEEDS_YES, "qualify");
  assert.equal(plain.message, "Not started: it needs your yes first. Ask in Chat for a preview.");
  assert.deepEqual(plain.next, { label: "Preview in Chat", draft: "Preview qualify" });
  assert.doesNotMatch(plain.message, /--approve|max-usd/);
  assert.match(refusal(`${NEEDS_YES} This schedule's approval ended on 2026-10-01: renew schedule.approvedUntil in workflows/index.ts.`, "digest").message, /ended on 2026-10-01\. Ask in Chat to renew it\.$/);
  assert.match(refusal(`${NEEDS_YES} This schedule's approval is missing: renew it.`, "digest").message, /has no yes yet/);
  assert.match(refusal(`${NEEDS_YES} No completed preview of this exact input in the last 24 hours: run --preview first.`, "qualify").message, /fresh preview/);
  assert.equal(refusal("qualify has spent $50.00 of its $50 this month.", "qualify").message, "Not started: this workflow has used its budget for the month ($50.00 of $50).");
  assert.match(refusal("The project has spent $1000.00 of its $1000 this month.", "qualify").message, /the project has used its budget/);
  assert.deepEqual(refusal("fanOut: the parent run x is not in the ledger.", "child"), { message: "fanOut: the parent run x is not in the ledger." });
});

test("the Overview's starter check matches the text a new project's context/company.md starts with", () => {
  assert.match(readFileSync(new URL("../../starter/context/company.md", import.meta.url), "utf8"), /^# .+\s+Replace the heading with the company's name/);
});

test("byFolder: folders by name with their workflows as written, and the workflows in none", () => {
  const w = (name, folder) => ({ name, ...(folder && { folder }) });
  const names = ({ folders, loose }) => [folders.map((f) => [f.name, f.items.map((x) => x.name).join(" ")]), loose.map((x) => x.name).join(" ")];
  const list = [w("loose"), w("report", "Reporting"), w("find", "Outbound"), w("score", "Outbound"), w("sync", "Reporting"), w("digest")];
  assert.deepEqual(names(byFolder(list)), [[["Outbound", "find score"], ["Reporting", "report sync"]], "loose digest"]);
  assert.deepEqual(names(byFolder([w("b"), w("a")])), [[], "b a"], "no folders: one list as written");
  assert.deepEqual(byFolder([]), { folders: [], loose: [] });
});
