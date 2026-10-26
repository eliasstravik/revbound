/**
 * GitHub for pull requests, through eve's git extension: a Vercel Connect connector named "revbound" (uid
 * "github/revbound") with access to this project's repository, which Vercel names in its system variables. The token
 * reaches only the sandbox firewall, for one command at a time. Locally, and without the repository's name, there is
 * no GitHub access: the agent's edits are the change.
 */
import type { GitHubLeaseRule } from "eve/extensions/git";
import type { SandboxSession } from "eve/sandbox";
import { onVercel } from "../app.js";
import { EGRESS } from "./sandbox.js";

export const CONNECTOR = "github/revbound";

type Firewall = SandboxSession & { setNetworkPolicy?(policy: { allow: Record<string, readonly GitHubLeaseRule[]> }): Promise<void> };

/** Adds the GitHub credential at the sandbox firewall for one command, then removes it. */
async function broker(sandbox: SandboxSession, rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null) {
  const s = sandbox as Firewall;
  if (!s.setNetworkPolicy) throw new Error("GitHub access works on the deployed agent only.");
  await s.setNetworkPolicy({ allow: { ...EGRESS, ...rules } });
}

/** The git extension's GitHub settings, or undefined when there is no GitHub here. */
export function github(env: Record<string, string | undefined> = process.env) {
  const owner = env.VERCEL_GIT_REPO_OWNER, slug = env.VERCEL_GIT_REPO_SLUG;
  if (!onVercel(env) || !owner || !slug) return undefined;
  const repository = `${owner}/${slug}`.toLowerCase();
  return { connector: CONNECTOR, org: owner, broker, authorize: ({ repository: r }: { repository: string }) => r.toLowerCase() === repository };
}
