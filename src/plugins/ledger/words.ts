/** How the Console words a run's reason: a failure's own message without the step path, a refused start for a person. */

/** `Step "<path>" failed after N retries: <message>` → the message, the step's short name and its tries. */
export function splitReason(reason: string): { message: string; step?: string; tries?: number } {
  const m = reason.match(/^Step "([^"]+)" failed after (\d+) retr(?:y|ies): ([\s\S]+)$/);
  return m ? { message: m[3], step: m[1].split("/").filter(Boolean).at(-1), tries: Number(m[2]) } : { message: reason };
}

/** What a chat draft link asks for: "preview" or "run" this workflow, or anything else as written. */
export type Next = { label: string; draft: string };

/**
 * A refused start in the person's words, with the next step in Chat when there is one. The ledger's own text is
 * written for the agent that asked (it names CLI flags); reasons this does not know are shown as they are.
 */
export function refusal(reason: string, workflow: string): { message: string; next?: Next } {
  const preview = { label: "Preview in Chat", draft: `Preview ${workflow}` };
  if (!reason.startsWith("This workflow needs a person's yes.")) {
    const spent = reason.match(/^(.+) has spent (\$[\d.]+) of its (\$[\d.]+) this month\.$/);
    if (spent) return { message: `Not started: ${spent[1] === "The project" ? "the project" : "this workflow"} has used its budget for the month (${spent[2]} of ${spent[3]}).`,
      next: { label: "Ask in Chat", draft: `Raise the monthly budget for ${workflow}` } };
    return { message: reason };
  }
  const ended = reason.match(/This schedule's approval (?:ended on (\S+?):? |is missing)/);
  if (ended) return { message: ended[1] ? `Not started: the yes for its schedule ended on ${ended[1]}. Ask in Chat to renew it.` : "Not started: its schedule has no yes yet. Ask in Chat to approve it.",
    next: { label: "Renew in Chat", draft: `Renew the schedule approval for ${workflow}` } };
  if (/No completed preview/.test(reason)) return { message: "Not started: it needs a fresh preview before your yes. Ask in Chat for a preview.", next: preview };
  return { message: "Not started: it needs your yes first. Ask in Chat for a preview.", next: preview };
}
