/** The revbound skill's form (the skill-issue standard's QC) and its copy of the interaction rules. No build needed. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), "utf8");
const skill = read("skills/revbound/SKILL.md");
const [, front, body] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];

test("frontmatter: name matches the folder; description third person, at most 1,024 characters, no XML", () => {
  assert.ok(front, "SKILL.md starts with frontmatter");
  assert.match(front, /^name: revbound$/m);
  const description = front.match(/^description: (.*)$/m)?.[1] ?? "";
  assert.ok(description.length > 0 && description.length <= 1024, `description is ${description.length} characters`);
  assert.doesNotMatch(description, /[<>]/);
  // A plain YAML scalar: hosts with strict YAML parsers (Cursor) drop a skill whose description holds ": " or " #".
  assert.doesNotMatch(description, /: | #|^["'&*!|>%@`{[]/);
  assert.match(description, /^Sets up/);
  assert.match(description, /Triggers when/);
  assert.match(description, /Not for/);
});

test("body: the nine sections in order, under 500 lines", () => {
  const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ["Trigger", "Scope", "Inputs", "Roles", "Procedure", "Outputs", "Exceptions", "QC", "References"]);
  assert.ok(body.split("\n").length < 500);
});

test("every relative link in the skill resolves inside the skill", () => {
  for (const [, href] of skill.matchAll(/\]\(([^)#]+)\)/g)) assert.ok(fs.existsSync(new URL(`skills/revbound/${href}`, root)), href);
});

test("the skill's interaction rules are docs/interaction.md, byte for byte", () => {
  assert.equal(read("skills/revbound/references/interaction.md"), read("docs/interaction.md"));
});
