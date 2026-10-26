/**
 * The yes, enforced by code: a real run waits for a person's answer on an approval request, and only the person whose
 * turn asked for it can settle it. Deployed, previews need no yes (the ledger caps them, and the code they run went
 * through review); on a laptop they do, since they run code the agent may just have edited, with the laptop's keys.
 * git__gh refuses anything but a pull-request branch, so nothing reaches main except through review.
 */
import type { ApprovalResponsePolicy, ApprovalStatus } from "eve/tools/approval";
import { isHosted } from "revbound/kit";

type Principal = { authenticator: string; issuer?: string; principalType: string; principalId: string };

export function samePrincipal(a: Principal, b: Principal): boolean {
  return a.authenticator === b.authenticator && a.issuer === b.issuer && a.principalType === b.principalType && a.principalId === b.principalId;
}

/** Only the person who asked can approve or cancel; anyone else's click is refused and the request stays open. */
export const requesterOnly: ApprovalResponsePolicy<any> = ({ request, response }) =>
  request.principal !== null && samePrincipal(response.principal, request.principal)
    ? { status: "allowed" }
    : { status: "rejected", reason: "Only the person who asked can answer this." };

/** start_run: deployed previews run at once; every other start waits for the requester's yes. */
export const runApproval = ({ toolInput }: { toolInput?: { preview?: boolean } }, hosted = isHosted()): ApprovalStatus =>
  toolInput?.preview === true && hosted ? "not-applicable" : "user-approval";

/** A branch the agent may write: its own `revbound/<name>` branches, never the default branch. */
const OWN_BRANCH = /^revbound\/[A-Za-z0-9._/-]+$/;

/** Splits a command line into words, honouring simple quotes (git__gh takes argv syntax only). */
export function words(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Every value of a flag, in any form the CLIs accept: `--name v`, `--name=v`, `-X v`, `-Xv`, `-X=v`. */
const flags = (w: string[], ...names: string[]) => {
  const out: string[] = [];
  for (let i = 0; i < w.length; i++) {
    for (const n of names) {
      if (w[i] === n) out.push(w[i + 1]);
      else if (w[i].startsWith(`${n}=`)) out.push(w[i].slice(n.length + 1));
      else if (/^-[A-Za-z]$/.test(n) && w[i].startsWith(n) && w[i].length > 2) out.push(w[i].slice(2));
    }
  }
  return out;
};

/** A flag's one value; given twice it is refused, since the CLIs differ on which one wins. */
const flag = (w: string[], ...names: string[]): string | undefined | null => {
  const all = flags(w, ...names);
  return all.length > 1 ? null : all[0];
};

/**
 * Which authenticated GitHub commands git__gh runs: reads, fetches, pushes and signed commits to a `revbound/<name>`
 * branch, and pull requests (create, view, comment, checks). Merging, pushing elsewhere, deleting or changing settings
 * is refused with the reason, so a change reaches main only through a reviewed pull request.
 */
export function githubCommand(command: string): ApprovalStatus {
  const w = words(command.trim());
  const deny = (reason: string): ApprovalStatus => ({ type: "denied", reason: `${reason} Changes go out as a pull request from a revbound/<name> branch.` });
  const [tool, sub, verb] = w;
  if (tool === "git") {
    if (["fetch", "pull", "ls-remote"].includes(sub)) return "not-applicable";
    if (sub !== "push") return deny(`git ${sub ?? ""} is not allowed here.`);
    if (w.some((x) => /^(-f|--force|--force-with-lease.*|--delete|-d|--mirror|--all|--tags)$/.test(x))) return deny("Force, delete and mirror pushes are refused.");
    const refs = w.slice(2).filter((x) => !x.startsWith("-")).slice(1);
    if (!refs.length) return deny("Name the branch: git push origin revbound/<name>.");
    for (const ref of refs) {
      const target = ref.includes(":") ? ref.split(":").pop()! : ref;
      if (!OWN_BRANCH.test(target.replace(/^refs\/heads\//, ""))) return deny(`Pushing to ${target} is refused.`);
    }
    return "not-applicable";
  }
  if (tool === "gh-signed-commit") {
    const branch = flag(w, "--branch", "-B");
    if (branch === null) return deny("Give --branch once.");
    return branch && OWN_BRANCH.test(branch) ? "not-applicable" : deny(`gh-signed-commit to ${branch ?? "(no --branch)"} is refused.`);
  }
  if (tool !== "gh") return deny(`${tool ?? "(empty)"} is not allowed here.`);
  if (sub === "repo" && ["view", "clone"].includes(verb)) return "not-applicable";
  if (sub === "pr" && ["create", "view", "list", "status", "checks", "diff", "comment"].includes(verb)) {
    const head = flag(w, "--head", "-H");
    if (head === null) return deny("Give --head once.");
    if (verb === "create" && head !== undefined && !OWN_BRANCH.test(head)) return deny(`A pull request from ${head} is refused.`);
    return "not-applicable";
  }
  if (["run", "issue", "search", "status", "auth"].includes(sub) && ["view", "list", "status", "watch", undefined].includes(verb)) return "not-applicable";
  if (sub === "api") {
    const given = flag(w, "--method", "-X");
    if (given === null) return deny("Give --method once.");
    const method = (given ?? "GET").toUpperCase();
    // Fields and input turn a request into a write; short options may come joined (`-fk=v`, `-XPUT`).
    const writes = w.some((x) => /^(-[fF]|--field|--raw-field|--input)/.test(x));
    return method === "GET" && !writes ? "not-applicable" : deny("gh api may only read here.");
  }
  return deny(`gh ${[sub, verb].filter(Boolean).join(" ")} is not allowed here.`);
}
