import { definePlugin } from "revbound";

const P = "revbound/context";
const SRC = "revbound/src/plugins/context";

/** What the company knows (context/**\/*.md) and its skills (.agents/skills), shown read-only as the console's home. */
export function context() {
  return definePlugin({
    name: "context",
    api: 1,
    routes: [
      { path: "context", methods: ["GET"], access: "session", handler: `${P}/routes#list` },
      { path: "context/file", methods: ["GET"], access: "session", handler: `${P}/routes#file` },
    ],
    views: [{ path: "context", title: "Context", nav: { label: "Context", order: 10 }, component: `${P}/view` }],
    trace: ["./context/**", "./.agents/skills/**"],
    agents: `- \`context/\`: what the company knows (facts), Markdown in any shape; the console's Context view shows it. Add context only
  when a person asks for it; for a kind the docs suggest a shape for, read \`npx revbound docs context\` first.
- \`.agents/skills/<name>/SKILL.md\`: the company's own skills, one folder each, with front matter \`name\` (the folder's name) and
  \`description\`. Create them there only, never through \`.claude/skills\` (a link to it). A workflow stage uses one with
  \`agent({ skills: ["<name>"] })\`. Folders named \`<plugin>-<skill>\` are installed by \`revbound sync\`; leave them alone.`,
    docs: { context: `${SRC}/docs/context.md` },
  });
}
