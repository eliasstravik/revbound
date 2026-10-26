/**
 * The agent plugin's Next.js transform: under `revbound dev`, a rewrite of /eve/v1/* to the agent's dev server (dev.ts);
 * proxy.ts checks every such request first. Deployed, vercel.json declares the app and the agent as two services and
 * routes /eve/v1/* to the agent (checks.ts insists on it), so there is nothing to add here.
 */
import type { NextConfig } from "next";

export default function next(cfg: NextConfig) {
  const target = process.env.REVBOUND_AGENT_URL;
  if (!target) return cfg;
  const rule = { source: "/eve/v1/:path*", destination: `${target}/eve/v1/:path*` };
  return {
    ...cfg,
    async rewrites() {
      const own = await cfg.rewrites?.();
      if (!own) return { beforeFiles: [rule], afterFiles: [], fallback: [] };
      if (Array.isArray(own)) return { beforeFiles: [rule], afterFiles: own, fallback: [] };
      return { ...own, beforeFiles: [rule, ...(own.beforeFiles ?? [])] };
    },
  };
}
