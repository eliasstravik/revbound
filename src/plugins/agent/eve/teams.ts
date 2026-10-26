/**
 * Microsoft Teams at /eve/v1/teams, on the same agent. Credentials: MICROSOFT_APP_ID, MICROSOFT_APP_PASSWORD and
 * MICROSOFT_TENANT_ID. Only people of the company's own Microsoft tenant reach it (a missing tenant id refuses
 * everyone); people from other organizations, bots and the agent itself are dropped. Approval cards answer only for
 * the person who asked (approval.ts on each tool).
 */
import { defaultTeamsAuth, teamsChannel, type TeamsInvokeActivity, type TeamsMessageActivity } from "eve/channels/teams";
import { value } from "revbound/kit";

/** From a person of the company's tenant, never a bot. */
export function fromCompany(activity: TeamsMessageActivity | TeamsInvokeActivity, tenant = value("MICROSOFT_TENANT_ID")): boolean {
  const from = activity.tenantId ?? activity.conversation.tenantId;
  return Boolean(tenant && from === tenant && activity.from.role !== "bot" && activity.from.id !== activity.recipient.id && activity.from.aadObjectId);
}

export default teamsChannel({
  async onMessage(ctx, message) {
    if (!fromCompany(message)) return null;
    return message.scope === "personal" || message.isBotMentioned || (await ctx.isSubscribed()) ? { auth: defaultTeamsAuth(message) } : null;
  },
  onInputResponse: (_ctx, activity) => (fromCompany(activity) ? { auth: defaultTeamsAuth(activity) } : null),
});
