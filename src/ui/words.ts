/** Words every Console page shares: relative times, run statuses, schedules, money and key names. Plain functions, no React. */

/** "just now", "12m ago", "5h ago", "3d ago". */
export function ago(value: string | number, now = Date.now()): string {
  const seconds = Math.round((now - new Date(value).getTime()) / 1000), minutes = Math.round(seconds / 60);
  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export const usd = (n: number) => (n > 0 && n < 0.0001 ? "under $0.0001" : n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export type Tone = "ok" | "failed" | "running" | "amber" | "muted";
const STATUS: Record<string, [string, Tone]> = {
  admitted: ["Starting", "running"], pending: ["Queued", "running"], running: ["Running", "running"], completed: ["Completed", "ok"], failed: ["Failed", "failed"],
  refused: ["Not started", "amber"], start_failed: ["Not started", "amber"], cancelled: ["Cancelled", "muted"], unknown: ["Unknown", "muted"],
};
/** A run status (the ledger's or the engine's) as the Console's one word for it and its colour. */
export const statusOf = (status: string): { word: string; tone: Tone } => {
  const [word, tone] = STATUS[status] ?? [status ? status[0].toUpperCase() + status.slice(1) : "Unknown", "muted"];
  return { word, tone };
};
export const isActive = (status?: string | null) => status === "admitted" || status === "running" || status === "pending";
/** A last run that needs a look: it failed, or never started for a reason other than a missing yes. */
export const needsLook = (status?: string | null) => status === "failed" || status === "start_failed";

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const pad = (n: number | string) => String(n).padStart(2, "0");
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * One cron expression (UTC) in words, at the viewer's own time, with the UTC time (or the expression) as `title`:
 * every N minutes or hours, hourly, daily, weekdays, weekly and monthly; anything else is "Custom schedule".
 */
export function cronWords(cron: string, now = new Date()): { text: string; title: string } {
  const [minute, hour, day, month, weekday, ...rest] = cron.trim().split(/\s+/), custom = { text: "Custom schedule", title: cron };
  if (rest.length || weekday === undefined || month !== "*") return custom;
  const every = (f: string) => f.match(/^\*\/(\d+)$/)?.[1], num = (f: string) => /^\d+$/.test(f), anyDay = day === "*" && weekday === "*";
  if (anyDay && hour === "*") {
    if (minute === "*" || every(minute) === "1") return { text: "Every minute", title: cron };
    if (every(minute)) return { text: `Every ${every(minute)} minutes`, title: cron };
    if (num(minute)) return { text: Number(minute) ? `Every hour at :${pad(minute)}` : "Every hour", title: cron };
  }
  if (anyDay && every(hour) && num(minute)) return { text: every(hour) === "1" ? "Every hour" : `Every ${every(hour)} hours`, title: cron };
  if (!num(minute) || !num(hour)) return custom;
  // This week's occurrence, so the viewer's time follows today's daylight saving.
  const at = new Date(now);
  at.setUTCHours(Number(hour), Number(minute), 0, 0);
  if (num(weekday)) at.setUTCDate(at.getUTCDate() + ((Number(weekday) % 7) - at.getUTCDay()));
  const utc = `${pad(hour)}:${pad(minute)} UTC`, local = `${pad(at.getHours())}:${pad(at.getMinutes())}`, sameDay = at.getDate() === at.getUTCDate();
  if (anyDay) return { text: `Daily ${local}`, title: utc };
  if (day === "*" && num(weekday) && Number(weekday) <= 7) return { text: `${DAYS[at.getDay()]} ${local}`, title: `${DAYS[at.getUTCDay()]} ${utc}` };
  if (day === "*" && weekday === "1-5") return { text: `Weekdays ${sameDay ? local : utc}`, title: `Weekdays ${utc}` };
  if (num(day) && weekday === "*") return { text: `Monthly on the ${ordinal(Number(day))}, ${sameDay ? local : utc}`, title: `${ordinal(Number(day))} of each month, ${utc}` };
  return custom;
}

const NAMES: Record<string, string> = { hubspot: "HubSpot", openai: "OpenAI", linkedin: "LinkedIn", github: "GitHub", ai: "AI", api: "API", crm: "CRM", url: "URL", id: "ID" };
/** A key's friendly name from its variable: FIRECRAWL_API_KEY is "Firecrawl". */
export function keyName(key: string): string {
  const words = key.replace(/_(API_KEY|ACCESS_TOKEN|BOT_TOKEN|AUTH_TOKEN|SIGNING_SECRET|CLIENT_SECRET|TOKEN|SECRET|KEY)$/i, "").split(/_+/).filter(Boolean);
  return words.map((w) => NAMES[w.toLowerCase()] ?? w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ") || key;
}

/** Workflows by their `group`: groups in the order first written, those without one last (`group: null`). Inside a
 * group numbered steps come first, in order, then the rest as written; `steps` says the group has any. */
export function byGroup<T extends { group?: string; step?: number }>(list: T[]): { group: string | null; steps: boolean; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const w of list) groups.set(w.group ?? null, [...(groups.get(w.group ?? null) ?? []), w]);
  const loose = groups.get(null);
  groups.delete(null);
  const out = [...groups].map(([group, items]) => ({ group, steps: items.some((w) => w.step != null), items: items.sort((a, b) => (a.step ?? 1e9) - (b.step ?? 1e9)) }));
  return loose ? [...out, { group: null, steps: false, items: loose }] : out;
}
