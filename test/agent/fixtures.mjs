// Slack Web API responses in the shape Slack returns them (trimmed to the fields that matter plus a few neighbours),
// recorded from Slack's API reference examples for auth.test, users.info and conversations.info.

export const TEAM = "T0ACME0001";
export const OTHER_TEAM = "T0OTHER001";
export const ENTERPRISE = "E0ACME0001";
export const GRID_SISTER_TEAM = "T0SISTER01";
export const BOT_USER = "U0BOT00001";

/** `auth.test` for a bot installed in one workspace. */
export const authTest = {
  ok: true, url: "https://acme.slack.com/", team: "Acme", user: "revbound", team_id: TEAM, user_id: BOT_USER,
  bot_id: "B0BOT00001", is_enterprise_install: false,
};

/** `auth.test` for a bot installed in a workspace of an Enterprise Grid org. */
export const authTestGrid = { ...authTest, enterprise_id: ENTERPRISE };

function user(id, fields = {}) {
  return {
    id, team_id: TEAM, name: id.toLowerCase(), deleted: false, color: "9f69e7", real_name: `Person ${id}`,
    tz: "Europe/Stockholm", tz_label: "Central European Summer Time", tz_offset: 7200,
    profile: { real_name: `Person ${id}`, display_name: id.toLowerCase(), team: TEAM },
    is_admin: false, is_owner: false, is_primary_owner: false, is_restricted: false, is_ultra_restricted: false,
    is_bot: false, is_app_user: false, updated: 1760000000, has_2fa: true,
    ...fields,
  };
}

/** `users.info` bodies by user id. */
export const users = {
  U0MEMBER01: { ok: true, user: user("U0MEMBER01") },
  U0MEMBER02: { ok: true, user: user("U0MEMBER02") },
  U0GUEST001: { ok: true, user: user("U0GUEST001", { is_restricted: true }) },
  U0SINGLE01: { ok: true, user: user("U0SINGLE01", { is_restricted: true, is_ultra_restricted: true }) },
  U0BOTUSER1: { ok: true, user: user("U0BOTUSER1", { is_bot: true, profile: { bot_id: "B0OTHER001" } }) },
  U0DELETED1: { ok: true, user: user("U0DELETED1", { deleted: true }) },
  U0EXTERNAL: { ok: true, user: user("U0EXTERNAL", { team_id: OTHER_TEAM, profile: { team: OTHER_TEAM } }) },
  W0GRIDSIS1: {
    ok: true,
    user: user("W0GRIDSIS1", { team_id: GRID_SISTER_TEAM, enterprise_user: { id: "W0GRIDSIS1", enterprise_id: ENTERPRISE, enterprise_name: "Acme Grid", is_admin: false, is_owner: false, teams: [GRID_SISTER_TEAM] } }),
  },
  W0GRIDOTH1: {
    ok: true,
    user: user("W0GRIDOTH1", { team_id: "T0OTHERGRD", enterprise_user: { id: "W0GRIDOTH1", enterprise_id: "E0OTHER001", enterprise_name: "Other Grid", teams: ["T0OTHERGRD"] } }),
  },
  U0MISSING1: { ok: false, error: "user_not_found" },
};

function channel(id, fields = {}) {
  return {
    id, name: `channel-${id.toLowerCase()}`, is_channel: true, is_group: false, is_im: false, is_mpim: false,
    is_private: false, created: 1700000000, is_archived: false, is_general: false, unlinked: 0,
    name_normalized: `channel-${id.toLowerCase()}`, is_shared: false, is_org_shared: false, is_pending_ext_shared: false,
    pending_shared: [], context_team_id: TEAM, updated: 1760000000, parent_conversation: null, creator: "U0MEMBER01",
    is_ext_shared: false, shared_team_ids: [TEAM], pending_connected_team_ids: [], is_member: true,
    topic: { value: "", creator: "", last_set: 0 }, purpose: { value: "", creator: "", last_set: 0 },
    ...fields,
  };
}

/** `conversations.info` bodies by conversation id. */
export const conversations = {
  C0PUBLIC01: { ok: true, channel: channel("C0PUBLIC01") },
  G0PRIVATE1: { ok: true, channel: channel("G0PRIVATE1", { is_channel: false, is_group: true, is_private: true }) },
  C0CONNECT1: { ok: true, channel: channel("C0CONNECT1", { is_shared: true, is_ext_shared: true, shared_team_ids: [TEAM, OTHER_TEAM] }) },
  C0PENDING1: { ok: true, channel: channel("C0PENDING1", { is_pending_ext_shared: true, pending_shared: [OTHER_TEAM], pending_connected_team_ids: [OTHER_TEAM] }) },
  C0ORGSHARE: { ok: true, channel: channel("C0ORGSHARE", { is_shared: true, is_org_shared: true, shared_team_ids: [TEAM, GRID_SISTER_TEAM] }) },
  // A DM object carries no Slack Connect flags.
  D0DIRECT01: {
    ok: true,
    channel: { id: "D0DIRECT01", created: 1700000000, is_archived: false, is_im: true, is_org_shared: false, context_team_id: TEAM, updated: 1760000000, user: "U0MEMBER01", is_user_deleted: false, priority: 0 },
  },
  C0MISSING1: { ok: false, error: "channel_not_found" },
};
