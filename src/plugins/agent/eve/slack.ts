/**
 * Slack at /eve/v1/slack, on the same agent as the console chat. Credentials: SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.
 * Every entry hook runs the same member check (members.ts); a hook this agent does not use is still defined, so
 * anything added later sits behind the check. Approval buttons answer only through Slack's own controls, and only for
 * the person who asked (approval.ts on each tool).
 */
import { defaultSlackAuth, slackChannel, type SlackInboundMessageContext, type SlackMessage } from "eve/channels/slack";
import { isHosted, value } from "revbound/kit";
import { allowed } from "../members.js";

/** A message starts a turn only from a full member of the company's Slack, in a conversation not shared outside it. */
async function admit(ctx: SlackInboundMessageContext, message: SlackMessage) {
  if (message.author?.isBot) return null;
  return (await allowed(ctx.slack, message.author?.userId, message.channelId)) ? { auth: defaultSlackAuth(message, ctx) } : null;
}

/** A stand-in Slack Web API for tests on a laptop (REVBOUND_SLACK_API_URL); never on a deployment. */
const testApi = !isHosted() && value("REVBOUND_SLACK_API_URL");

export default slackChannel({
  ...(testApi && { api: { apiBaseUrl: testApi } }),
  onAppMention: admit,
  onDirectMessage: admit,
  // Without a mention, a message counts only in a thread this agent is already working in.
  onMessage: async (ctx, message) => ((await ctx.isSubscribed()) ? admit(ctx, message) : null),
  onInputResponse: async (ctx, submission) =>
    (await allowed(ctx.slack, submission.user.id, ctx.slack.channelId)) ? { auth: ctx.defaultAuth } : null,
  async onSlashCommand(command, ctx) {
    if (!(await allowed(ctx.slack, command.user.id, command.channelId))) return;
  },
  async onShortcut(shortcut, ctx) {
    if (!(await allowed(ctx.slack, shortcut.user.id, shortcut.type === "message_action" ? shortcut.channelId : undefined))) return;
  },
  async onInteraction(action, ctx) {
    if (!(await allowed(ctx.slack, action.user.id, ctx.slack.channelId))) return;
  },
  async onEvent(ctx, event) {
    const user = typeof event.user === "string" ? event.user : undefined;
    const channel = typeof event.channel === "string" ? event.channel : undefined;
    if (!channel || !(await allowed(ctx.slack, user, channel))) return;
  },
});
