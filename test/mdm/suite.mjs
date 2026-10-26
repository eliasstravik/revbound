/**
 * mdm's rules on a real database: matching and de-duplication, merging, signal de-duplication and "what is known since
 * when". Each test uses its own domains and emails, so tests never see each other's records. Run by postgres.test.mjs and
 * pglite.test.mjs.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const dist = (p) => import(path.join(REPO, "dist", p));

export async function suite({ url, concurrent }) {
  process.env.DATABASE_URL = url;
  const { applyPlan } = await dist("plugins/database/migrate.js");
  const provideDb = (await dist("plugins/database/provide.js")).default;
  const provideMdm = (await dist("plugins/mdm/provide.js")).default;
  const folder = (p) => path.join(REPO, "src", "plugins", p, "migrations");
  await applyPlan({ sets: [{ id: "database", schema: "gtm", folder: folder("database") }, { id: "mdm", schema: "gtm_mdm", folder: folder("mdm") }], destructive: [] }, url);
  const database = provideDb({});
  const mdm = provideMdm({ manifest: { plugins: [], connections: [] }, plugin: "mdm", options: {}, has: () => true, get: () => database, module: async () => ({}) });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const q = async (text, values) => (await client.query(text, values)).rows;
  let n = 0;
  /** A fresh domain, so each test has its own companies. */
  const fresh = (label = "co") => `${label}${Date.now().toString(36)}${(n += 1)}.example`;
  const by = (source, workflow = null, runId = null) => ({ source, workflow, runId });

  test("companies match on any spelling of their domain, LinkedIn page or ids, and land as one record", async () => {
    const d = fresh();
    const a = await mdm.upsertCompany({ domain: `https://www.${d.toUpperCase()}/about?x=1`, name: "Acme" }, by("list-import"));
    assert.deepEqual([a.created, a.domain, a.name, a.conflicts], [true, d, "Acme", []]);
    const b = await mdm.upsertCompany({ domain: `${d}.`, linkedin: `https://uk.linkedin.com/company/${d}-inc/` }, by("crawler"));
    assert.deepEqual([b.id, b.created, b.linkedin], [a.id, false, `linkedin.com/company/${d}-inc`]);
    const c = await mdm.upsertCompany({ linkedin: `linkedin.com/company/${d.toUpperCase()}-INC`, ids: { hubspot: 42 } }, by("crm"));
    assert.equal(c.id, a.id);
    assert.deepEqual(c.keys.map((k) => [k.key, k.value, k.source]), [["domain", d, "list-import"], ["linkedin", `linkedin.com/company/${d}-inc`, "crawler"], ["id:hubspot", "42", "crm"]]);
    assert.equal((await mdm.findCompany({ ids: { hubspot: "42" } })).id, a.id);
    assert.equal((await mdm.findCompany({ domain: `http://${d}:8080` })).id, a.id);
    assert.equal(await mdm.findCompany({ domain: fresh() }), null);
    assert.equal((await q("select count(*)::int as n from gtm_mdm.companies where domain = $1", [d]))[0].n, 1);
  });

  test("people match on email or LinkedIn profile, link to their company, and a job change moves the link", async () => {
    const d = fresh(), other = fresh();
    const p = await mdm.upsertPerson({ email: ` Jane@${d.toUpperCase()} `, name: "Jane Doe", title: "CEO", company: { domain: d, name: "Acme" } }, by("list-import"));
    assert.deepEqual([p.created, p.email, p.title], [true, `jane@${d}`, "CEO"]);
    const acme = await mdm.findCompany({ domain: d });
    assert.equal(p.companyId, acme.id);
    const again = await mdm.upsertPerson({ linkedin: "https://www.linkedin.com/in/Jane-Doe-1/", email: `jane@${d}` }, by("crawler"));
    assert.deepEqual([again.id, again.created, again.name, again.linkedin], [p.id, false, "Jane Doe", "linkedin.com/in/jane-doe-1"]);
    const moved = await mdm.upsertPerson({ linkedin: "linkedin.com/in/jane-doe-1", title: "Founder", company: { domain: other } }, by("job-changes"));
    assert.equal(moved.id, p.id);
    assert.notEqual(moved.companyId, acme.id);
    assert.equal(moved.companyId, (await mdm.findCompany({ domain: other })).id);
    assert.equal(moved.title, "Founder");
    assert.equal((await mdm.upsertPerson({ email: `bob@${d}`, company: acme }, by("x"))).companyId, acme.id, "a company record links as it is");
  });

  test("keys owned by another record are reported as conflicts, never moved; bad keys and missing keys are refused", async () => {
    const d = fresh();
    const a = await mdm.upsertPerson({ email: `a@${d}` }, by("t")), b = await mdm.upsertPerson({ email: `b@${d}`, linkedin: `linkedin.com/in/b-${d}` }, by("t"));
    const r = await mdm.upsertPerson({ email: `a@${d}`, linkedin: `linkedin.com/in/b-${d}` }, by("t"));
    assert.deepEqual([r.id, r.conflicts], [a.id, [b.id]], "the email (the stronger key) wins");
    assert.equal(r.linkedin, null, "the LinkedIn profile stays with its record");
    for (const [input, re] of [[{ email: "not-an-email" }, /not an email/], [{ name: "No keys" }, /needs an email/], [{ linkedin: "linkedin.com/company/x" }, /LinkedIn profile/],
      [{ email: `c@${d}`, fields: { email: "x" } }, /its own input/], [{ id: randomUUID() }, /No person has the id/]]) {
      await assert.rejects(mdm.upsertPerson(input, by("t")), (e) => e.name === "MdmInputError" && re.test(e.message), JSON.stringify(input));
    }
    await assert.rejects(mdm.upsertCompany({ domain: d }, by(" ")), /names its source/);
  });

  test(`upserts of the same company at once make one record${concurrent ? "" : " (queued by the one session)"}`, async () => {
    // Each round starts from fresh pool connections, so the upserts reach the database together.
    for (let round = 0; round < 4; round += 1) {
      await database.db().$client.end();
      delete globalThis[Symbol.for("revbound/db")];
      const d = fresh();
      const all = await Promise.all(Array.from({ length: 12 }, (_, i) => mdm.upsertCompany({ domain: i % 2 ? d : `www.${d}`, fields: { [`seen${i}`]: true } }, by(`run${i}`))));
      assert.equal(new Set(all.map((c) => c.id)).size, 1);
      assert.equal(all.filter((c) => c.created).length, 1);
      assert.equal(Object.keys((await mdm.findCompany({ domain: d })).data).length, 12);
    }
  });

  test("merge folds one record into another: keys, fields, people and signals move, keep's values win, the old id finds the kept record", async () => {
    const d1 = fresh(), d2 = fresh();
    const keep = await mdm.upsertCompany({ domain: d1, name: "Acme", fields: { industry: "Software" } }, by("a"));
    const drop = await mdm.upsertCompany({ domain: d2, name: "Acme Inc", linkedin: `linkedin.com/company/${d2}`, fields: { industry: "Tech", employees: 40 } }, by("b"));
    const person = await mdm.upsertPerson({ email: `x@${d2}`, company: drop }, by("b"));
    const at = "2026-01-02T03:04:05.000Z";
    await mdm.upsertSignal({ about: keep, type: "funding_round", key: "series-a", at }, by("a"));
    await mdm.upsertSignal({ about: drop, type: "funding_round", key: "series-a", at }, by("b"));
    await mdm.upsertSignal({ about: drop, type: "job_posting", key: "https://jobs.example/1" }, by("b"));
    const merged = await mdm.merge(keep, drop);
    assert.deepEqual([merged.id, merged.name, merged.domain, merged.linkedin], [keep.id, "Acme", d1, `linkedin.com/company/${d2}`]);
    assert.deepEqual(merged.data, { industry: "Software", employees: 40 });
    assert.deepEqual(merged.keys.map((k) => k.value).sort(), [d1, d2, `linkedin.com/company/${d2}`].sort());
    const known = await mdm.known(keep);
    assert.deepEqual([known.industry.value, known.industry.source, known.employees.source], ["Software", "a", "b"]);
    assert.equal((await mdm.findCompany({ domain: d2 })).id, keep.id);
    assert.equal((await mdm.findCompany({ id: drop.id })).id, keep.id, "the dropped id finds the kept record");
    assert.equal((await mdm.findPerson({ email: `x@${d2}` })).companyId, keep.id);
    assert.deepEqual((await mdm.signals(keep)).map((s) => s.type).sort(), ["funding_round", "job_posting"], "the duplicate funding round is stored once");
    assert.equal((await mdm.upsertCompany({ id: drop.id, fields: { hq: "Oslo" } }, by("c"))).id, keep.id);
    const third = await mdm.upsertCompany({ domain: fresh() }, by("d"));
    await mdm.merge(third, keep);
    assert.equal((await mdm.findCompany({ id: drop.id })).id, third.id, "merging again keeps every old id one step from its record");
    assert.equal((await mdm.merge(third, drop)).id, third.id, "merging a record into itself changes nothing");
    await assert.rejects(mdm.merge(third, person), /cannot be merged/);
  });

  test("signals: the same record, type and key is stored once; data merges and the earliest time stays", async () => {
    const p = await mdm.upsertPerson({ email: `s@${fresh()}` }, by("t"));
    const first = await mdm.upsertSignal({ about: p, type: "job_change", key: "acme→globex", at: "2026-03-01T00:00:00Z", data: { from: "Acme" } }, by("run1"));
    const second = await mdm.upsertSignal({ about: { type: "person", id: p.id }, type: "job_change", key: "acme→globex", at: "2026-03-05T00:00:00Z", data: { to: "Globex" } }, by("run2"));
    assert.deepEqual([first.created, second.created, second.id, second.occurredAt, second.source], [true, false, first.id, "2026-03-01T00:00:00.000Z", "run1"]);
    assert.deepEqual(second.data, { from: "Acme", to: "Globex" });
    const visit = { about: p, type: "site_visit", at: new Date("2026-03-02T10:00:00Z") };
    assert.equal((await mdm.upsertSignal(visit, by("a"))).created, true);
    assert.equal((await mdm.upsertSignal(visit, by("b"))).created, false, "without a key, the time is the key");
    assert.equal((await mdm.upsertSignal({ ...visit, at: "2026-03-02T11:00:00Z" }, by("b"))).created, true);
    assert.deepEqual((await mdm.signals(p, { type: "site_visit" })).map((s) => s.occurredAt), ["2026-03-02T11:00:00.000Z", "2026-03-02T10:00:00.000Z"]);
    const posting = await mdm.upsertSignal({ about: p, type: "job_posting", key: "https://jobs.example/9", data: { title: "Engineer", company: "Acme", email: "x", name: "y" } }, by("jobs"));
    assert.deepEqual(posting.data, { title: "Engineer", company: "Acme", email: "x", name: "y" }, "signal data takes any detail names");
    await assert.rejects(mdm.upsertSignal({ about: p, type: "x", data: [1] }, by("t")), /A signal's data is an object/);
    await assert.rejects(mdm.upsertSignal({ about: p, type: "Job Change" }, by("t")), /not a signal type/);
    await assert.rejects(mdm.upsertSignal({ about: { type: "person", id: randomUUID() }, type: "x" }, by("t")), /No person has the id/);
  });

  test("known and stale: a person's email, LinkedIn profile and ids are known from when they were first stored", async () => {
    const d = fresh(), run = randomUUID();
    const p = await mdm.upsertPerson({ email: `jane@${d}`, title: "Engineer" }, by("email-vendor", "find", run));
    const k = await mdm.known(p, ["email", "title", "linkedin"]);
    assert.deepEqual(Object.keys(k), ["email", "title"]);
    assert.deepEqual([k.email.value, k.email.source, k.email.workflow, k.email.runId], [`jane@${d}`, "email-vendor", "find", run]);
    assert.deepEqual(await mdm.stale(p, ["email", "linkedin"]), ["linkedin"]);
    await mdm.upsertPerson({ email: `jane@${d}`, linkedin: `linkedin.com/in/jane-${d}`, ids: { crm: 7 } }, by("crawler"));
    await mdm.upsertPerson({ email: `jane.doe@${d}`, linkedin: `linkedin.com/in/jane-${d}` }, by("other"));
    const all = await mdm.known(p);
    assert.deepEqual([all.email.value, all.email.source, all.linkedin.source, all["id:crm"].value], [`jane@${d}`, "email-vendor", "crawler", "7"], "the first email stays the known one");
    assert.deepEqual(await mdm.stale(p, ["email", "linkedin", "id:crm"]), []);
    await q("update gtm_mdm.keys set created_at = now() - interval '40 days' where record_id = $1 and key = 'email'", [p.id]);
    assert.deepEqual(await mdm.stale(p, ["email", "linkedin"], { maxAgeDays: 30 }), ["email"]);
  });

  test("known and stale: each field's value, source, workflow, run and time; nothing found counts as known; old fields go stale", async () => {
    const run = randomUUID();
    const c = await mdm.upsertCompany({ domain: fresh(), name: "Initech", fields: { industry: "Software", funding: null } }, by("website", "enrich", run));
    const k = await mdm.known(c);
    assert.deepEqual(Object.keys(k), ["domain", "funding", "industry", "name"], "keys count as known");
    assert.deepEqual([k.industry.value, k.industry.source, k.industry.workflow, k.industry.runId, k.funding.value], ["Software", "website", "enrich", run, null]);
    assert.ok(Date.now() - Date.parse(k.industry.setAt) < 60_000);
    assert.deepEqual(await mdm.stale(c, ["industry", "funding", "employees"]), ["employees"]);
    assert.deepEqual(await mdm.stale(c, ["constructor", "toString", "industry"]), ["constructor", "toString"], "names an object inherits are unknown too");
    assert.deepEqual(Object.keys(await mdm.known(c, ["industry", "nope"])), ["industry"]);
    await q("update gtm_mdm.fields set set_at = now() - interval '40 days' where record_id = $1 and field = 'industry'", [c.id]);
    assert.deepEqual(await mdm.stale(c, ["industry", "funding"], { maxAgeDays: 30 }), ["industry"]);
    assert.deepEqual(await mdm.stale(c, ["industry", "funding"], { maxAgeDays: 60 }), []);
    await mdm.upsertCompany({ id: c.id, fields: { industry: "Fintech" } }, by("vendor"));
    const after = await mdm.known(c, ["industry"]);
    assert.deepEqual([after.industry.value, after.industry.source], ["Fintech", "vendor"]);
    assert.deepEqual(await mdm.stale(c, ["industry"], { maxAgeDays: 30 }), [], "a new write is fresh again");
  });

  test("teardown", async () => { await client.end(); await database.db().$client.end(); });
}
