/** The workflows plugin's Next.js transform: the Workflow SDK, and the vercel.json workflow crons baked in as GTM_CRONS. */
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { cronSchedules } from "revbound/kit/scan";

export default function next(cfg: NextConfig) {
  // Next 16 writes its own block into AGENTS.md on `next dev`; the file is the company's plus Revbound's managed block.
  return withWorkflow({ agentRules: false, ...cfg, env: { ...cfg.env, GTM_CRONS: JSON.stringify(cronSchedules(process.cwd())) } } as never);
}
