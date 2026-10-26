/**
 * `revbound agent [status] | add <channel> | remove <channel>`: which chat apps reach the project's agent. `add` and
 * `remove` change the agent() line in revbound.config.ts, sync, and print the steps only a person can do (creating
 * the chat app, its keys, the redeploy).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliCtx, CONFIG, loadEnv } from "revbound/cli";
import { value } from "revbound/kit";
import { CHANNEL_KEYS, CHANNELS, type Channel } from "./index.js";

const USAGE = `Usage: revbound agent [status] | add <channel> | remove <channel>   (channels: ${CHANNELS.join(", ")})`;

/** The config text with the agent() call's channels set to `channels`, or undefined when its shape is not one we can edit. */
export function withChannels(source: string, channels: readonly string[]): string | undefined {
  const list = `channels: [${channels.map((c) => JSON.stringify(c)).join(", ")}]`;
  const bare = /\bagent\(\s*\)/;
  if (bare.test(source)) return source.replace(bare, `agent({ ${list} })`);
  const call = /\bagent\(\{([^()]*?)\}\)/.exec(source);
  if (!call) return undefined;
  const body = call[1].trim().replace(/,$/, "");
  const inner = /\bchannels\s*:/.test(body) ? body.replace(/\bchannels\s*:\s*\[[^\]]*\]/, list) : body ? `${list}, ${body}` : list;
  return `${source.slice(0, call.index)}agent({ ${inner} })${source.slice(call.index + call[0].length)}`;
}

/** The production domain, from REVBOUND_PRODUCTION_URL when set. */
const domain = () => {
  const url = value("REVBOUND_PRODUCTION_URL");
  return url ? new URL(url.includes("://") ? url : `https://${url}`).host : "<production domain>";
};

/** A Slack app manifest for this agent: the scopes and events it uses, both URLs carrying Slack's own bypass secret. */
export function slackManifest(company: string, host: string) {
  const url = `https://${host}/eve/v1/slack?x-vercel-protection-bypass=<Slack's bypass secret>`;
  return {
    display_information: { name: `${company} GTM` },
    features: { bot_user: { display_name: `${company} GTM`, always_online: true }, app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
    oauth_config: {
      scopes: {
        bot: ["app_mentions:read", "channels:history", "channels:read", "chat:write", "files:read", "files:write", "groups:history",
          "groups:read", "im:history", "im:read", "im:write", "mpim:read", "users:read"],
      },
    },
    settings: {
      event_subscriptions: { request_url: url, bot_events: ["app_mention", "message.channels", "message.groups", "message.im"] },
      interactivity: { is_enabled: true, request_url: url },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}

function steps(channel: Exclude<Channel, "console">, company: string): string {
  const keys = CHANNEL_KEYS[channel].map((k) => `     vercel env add ${k.name} production --sensitive`).join("\n");
  const close = `   Then commit and push (or redeploy), so the deployed agent has the new channel.`;
  if (channel === "slack") {
    return `Steps only a person can do, once:
1. Vercel → this project → Settings → Deployment Protection → Protection Bypass for Automation: add a secret just for
   Slack (note "slack"). Never reuse the one your laptop uses.
2. https://api.slack.com/apps → Create New App → From a manifest → pick the company's workspace, paste this manifest
   with <Slack's bypass secret> replaced by that secret:

${JSON.stringify(slackManifest(company, domain()), null, 2)}

3. Install the app to the workspace. Then set its Bot User OAuth Token and its Signing Secret (Basic Information):
${keys}
${close}
4. In Slack, invite the app to a channel and mention it, or message it directly. Only full members of the workspace
   get answers; guests, other organizations and shared channels are ignored.`;
  }
  return `Steps only a person can do, once:
1. Create an Azure Bot (single tenant, the company's own Microsoft tenant) whose messaging endpoint is
   https://${domain()}/eve/v1/teams?x-vercel-protection-bypass=<Teams' bypass secret>, with its own bypass secret made as
   for Slack (Vercel → Deployment Protection → Protection Bypass for Automation, note "teams").
2. Set its keys:
${keys}
${close}
3. Add the bot to Teams for the company. Only people of the company's own tenant get answers.`;
}

export default async function run(args: string[], ctx: CliCtx): Promise<void> {
  const [verb = "status", name] = args;
  loadEnv(ctx.dir, true);
  const current = ((ctx.options as { channels?: Channel[] })?.channels ?? ["console"]) as Channel[];
  if (verb === "status" && !name) {
    console.log(`The agent answers in: ${current.map((c) => (c === "console" ? "the console's Chat page" : c)).join(", ")}.`);
    const missing = current.flatMap((c) => (c === "console" ? [] : CHANNEL_KEYS[c])).filter((k) => !value(k.name)).map((k) => k.name);
    if (missing.length) console.log(`Not set on this computer (set them on Vercel for production): ${missing.join(", ")}.`);
    return;
  }
  if ((verb !== "add" && verb !== "remove") || !name) throw new Error(USAGE);
  if (!(CHANNELS as readonly string[]).includes(name)) throw new Error(`${name} is not a channel the agent has. ${USAGE}`);
  const channel = name as Channel;
  const next = verb === "add" ? [...new Set([...current, channel])] : current.filter((c) => c !== channel);
  if (next.length === current.length && next.every((c, i) => c === current[i])) {
    console.log(verb === "add" ? `${channel} is already on.` : `${channel} is already off.`);
    if (verb === "add" && channel !== "console") console.log(`\n${steps(channel, ctx.config.company)}`);
    return;
  }
  const file = join(ctx.dir, CONFIG), source = readFileSync(file, "utf8");
  const edited = withChannels(source, next);
  if (!edited) {
    throw new Error(`${CONFIG} has no agent() line this command can change. Set it to agent({ channels: ${JSON.stringify(next)} }) yourself, then run npx revbound sync.`);
  }
  writeFileSync(file, edited);
  const { sync } = await import("revbound/cli");
  await sync(ctx.dir);
  console.log(`The agent ${verb === "add" ? "now answers in" : "no longer answers in"} ${channel === "console" ? "the console's Chat page" : channel}.`);
  if (verb === "add" && channel !== "console") console.log(`\n${steps(channel, ctx.config.company)}`);
}
