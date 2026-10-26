/**
 * Who may use the agent from Slack: full members of the company's own workspace (or its Enterprise Grid org), in
 * conversations not shared outside it. Guests, bots, deactivated accounts and Slack Connect channels are refused, and
 * every Slack API error refuses (fail closed).
 */

/** Slack Web API access: every eve Slack handler context has it as `ctx.slack`. */
export type Slack = { request(method: string, body: Record<string, string>): Promise<Record<string, unknown>> };

/** The company: the bot's own workspace, plus its Enterprise Grid org when it has one. */
export interface Company {
  teamId: string;
  enterpriseId?: string;
}

/** The `users.info` fields read. */
export interface SlackUser {
  team_id?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  enterprise_user?: { enterprise_id?: string };
}

/** The `conversations.info` fields read. */
export interface SlackConversation {
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
}

/**
 * A full member: not a guest, bot or deactivated account (Slack always sends these flags for a member; a missing one
 * refuses), and from the company's workspace or, on Enterprise Grid, any workspace of the same org.
 */
export function isMember(user: SlackUser, company: Company): boolean {
  if (user.deleted !== false || user.is_bot !== false) return false;
  if (user.is_restricted !== false || user.is_ultra_restricted !== false) return false;
  return user.team_id === company.teamId
    || (company.enterpriseId !== undefined && user.enterprise_user?.enterprise_id === company.enterpriseId);
}

/** Not shared with another organization through Slack Connect, nor invited to be. (DM objects carry no such flags.) */
export function isInternal(conversation: SlackConversation): boolean {
  return conversation.is_ext_shared !== true && conversation.is_pending_ext_shared !== true;
}

async function call(slack: Slack, method: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await slack.request(method, body);
  if (response.ok !== true) throw new Error(`Slack ${method} failed: ${String(response.error)}`);
  return response;
}

// Read from the bot's own token (auth.test) once per instance, never from the event envelope. A failure is not kept.
let company: Promise<Company> | undefined;
function ownCompany(slack: Slack): Promise<Company> {
  company ??= call(slack, "auth.test", {}).then(
    (r) => {
      if (typeof r.team_id !== "string" || !r.team_id) throw new Error("Slack auth.test returned no team_id");
      return { teamId: r.team_id, enterpriseId: typeof r.enterprise_id === "string" && r.enterprise_id ? r.enterprise_id : undefined };
    },
    (error: unknown) => {
      company = undefined;
      throw error;
    },
  );
  return company;
}

/**
 * Whether Slack user `userId` may use the agent in conversation `channelId` (omitted only for a global shortcut, which
 * has none). Fails closed: a missing id or any Slack API error refuses.
 */
export async function allowed(slack: Slack, userId: string | undefined, channelId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [us, { user }, conversation] = await Promise.all([
      ownCompany(slack),
      call(slack, "users.info", { user: userId }),
      channelId === undefined ? undefined : call(slack, "conversations.info", { channel: channelId }),
    ]);
    if (!user || !isMember(user as SlackUser, us)) return false;
    return conversation === undefined || (conversation.channel !== undefined && isInternal(conversation.channel as SlackConversation));
  } catch (error) {
    console.warn("Slack member check failed, refusing", error);
    return false;
  }
}
