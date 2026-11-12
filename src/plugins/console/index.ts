import { definePlugin } from "revbound";

const P = "revbound/console";

/**
 * The console: its frame (sidebar, environment badge), the page that shows whichever plugin view matches the path, the
 * 404, and its home, Overview (what needs attention, what runs now, recent runs and spend). Read and navigation only.
 */
export function console() {
  return definePlugin({
    name: "console",
    api: 1,
    shell: { layout: `${P}/layout`, page: `${P}/page` },
    views: [{ path: "overview", title: "Overview", nav: { label: "Overview", order: 0 }, component: `${P}/overview` }],
    routes: [{ path: "shell", methods: ["GET"], access: "session", handler: `${P}/routes#shell` }],
    agents: "- The console (`npm run dev`, then http://127.0.0.1:3000) only reads and navigates: it has no start, approve or key buttons.",
  });
}
