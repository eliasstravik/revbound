import { definePlugin } from "revbound";

const P = "revbound/console";

/**
 * The console: its frame (sidebar, environment badge), the page that shows whichever plugin view matches the path, and
 * the 404. Read and navigation only. Its home is the Context view when present, else Workflows.
 */
export function console() {
  return definePlugin({
    name: "console",
    api: 1,
    shell: { layout: `${P}/layout`, page: `${P}/page` },
    routes: [{ path: "shell", methods: ["GET"], access: "session", handler: `${P}/routes#shell` }],
    agents: "- The console (`npm run dev`, then http://127.0.0.1:3000) only reads and navigates: it has no start, approve or key buttons.",
  });
}
