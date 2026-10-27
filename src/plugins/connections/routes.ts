/**
 * The Connections view's routes: every connection name with its state here, never a value, and the console's changes.
 * Locally the state comes from .env.local and the shell, and changes write .env.local and .env.example; hosted the state
 * comes from this deployment's environment and Vercel's Production variables, which changes write.
 */
import type { About, RegistryInfo, RouteCtx } from "revbound";
import { environment, isHosted, json, safeEqual, value } from "revbound/kit";
import { checkValue, KEY, refusedName, writeEnvLocal, writeExample } from "./files.js";
import { type Change, changeHosted, type Done, hostedAccess, insist, type Production, productionVars, Refused, releaseState, type Save, type Session, settingsUrl,
  tokenWarning } from "./vercel.js";

type State = "set" | "missing" | "saved" | "provided" | "readonly";
type Info = Record<string, About & RegistryInfo>;
const ACTIONS = ["save", "rename", "delete", "redeploy"];
const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const reply = (body: unknown, status = 200) => { const r = json(body, status); for (const [k, v] of Object.entries(HEADERS)) r.headers.set(k, v); return r; };

/** The workflows each connection is used by come from the registry, when a workflows plugin is there. */
const registryOf = async (ctx: RouteCtx): Promise<Info> => (ctx.has("workflows") ? ctx.get("workflows").registry().catch(() => ({})) : {});

/** Whether changes work for this request, and hosted the owner session they run as. */
async function access(req: Request): Promise<{ save: Save; session?: Session }> {
  return isHosted() ? hostedAccess(req) : { save: { mode: "local" } };
}

/**
 * Names .env.example lists, plugins or workflows declare, and those set in .env.local (locally) or in Production (hosted,
 * read with the token), each with its state here and the changes allowed. Missing ones first.
 */
async function rows(ctx: RouteCtx, save: Save, production = true) {
  const hosted = isHosted(), dotenv = hosted ? undefined : await import("revbound/kit/dotenv");
  const local = dotenv?.envLocalNames() ?? [], registry = await registryOf(ctx);
  let vars = new Map<string, Production>(), listError: string | null = null;
  const token = value("REVBOUND_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID");
  if (production && hosted && process.env.VERCEL_ENV === "production" && token && projectId) {
    vars = await productionVars(token, projectId)
      .catch((e: Error) => { listError = `Could not read Production's keys: ${e.message}`; return vars; });
  }
  // Locally .env.example is read again (the manifest keeps only plugins' names), so a change here shows before the next sync.
  const example = dotenv?.exampleConnections() ?? [];
  const declared = new Map(ctx.manifest.connections.filter((c) => !dotenv || c.plugins.length).map((c) => [c.name, { ...c }]));
  for (const e of example) declared.set(e.name, { name: e.name, label: e.description || (declared.get(e.name)?.label ?? ""), plugins: declared.get(e.name)?.plugins ?? [] });
  const add = (n: string) => declared.has(n) || declared.set(n, { name: n, label: "", plugins: [] });
  for (const w of Object.values(registry)) for (const n of w.connections ?? []) add(n);
  for (const n of [...local, ...vars.keys()]) if (!refusedName(n, hosted)) add(n);
  const shell = (value("REVBOUND_SHELL_KEYS") ?? "").split(","), canChange = save.mode === "local" || save.mode === "hosted";
  const connections = [...declared.values()].map((c) => {
    const row = vars.get(c.name), reserved = refusedName(c.name, hosted), set = value(c.name) !== undefined || local.includes(c.name);
    const state: State = hosted && !set && /^AI_GATEWAY_/i.test(c.name) ? "provided" : row && !row.editable ? "readonly" : set ? "set" : row ? "saved" : "missing";
    const actions = !canChange || reserved || state === "provided" || state === "readonly" ? []
      : hosted ? (row ? ["save", "rename", "delete"] : ["save"])
      : ["save", "rename", ...(local.includes(c.name) || example.some((e) => e.name === c.name) ? ["delete"] : [])];
    const workflows = Object.entries(registry).filter(([, w]) => w.connections?.includes(c.name)).map(([n]) => n);
    return { name: c.name, label: row?.comment || c.label, state, actions, usedBy: { workflows, plugins: c.plugins },
      ...(reserved && { reserved: true }), ...(!hosted && shell.includes(c.name) && { shell: true }) };
  }).sort((a, b) => Number(b.state === "missing") - Number(a.state === "missing"));
  return { connections, listError, usageComplete: Object.values(registry).every((w) => Array.isArray(w.connections)) };
}

/** GET /connections → { connections, environment, save, tokenWarning, listError, settingsUrl, usageComplete }. */
export async function list(req: Request, ctx: RouteCtx): Promise<Response> {
  const { save } = await access(req), hosted = isHosted();
  return reply({ ...(await rows(ctx, save)), environment: environment(), save, tokenWarning: hosted ? tokenWarning() : null,
    settingsUrl: hosted ? await settingsUrl() : null });
}

/** GET /connections/release?id=dpl_… → { release: { state, details? } | null }: the badge's view of a redeploy a change started. */
export async function release(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!isHosted()) return reply({ release: null });
  if (!/^dpl_[A-Za-z0-9]{1,64}$/.test(id)) return reply({ error: "Send ?id=dpl_…" }, 400);
  return releaseState(id).then((r) => reply({ release: r }), (e: Error) => reply({ error: e.message }, e instanceof Refused ? e.status : 500));
}

/** GET /connections/missing[?workflow=] → { count }: the sidebar's badge, or one workflow's Connections tab badge. */
export async function missing(req: Request, ctx: RouteCtx): Promise<Response> {
  const workflow = new URL(req.url).searchParams.get("workflow");
  return json({ count: (await rows(ctx, { mode: "off" }, false)).connections
    .filter((r) => r.state === "missing" && (!workflow || r.usedBy.workflows.includes(workflow))).length });
}

/** The change a request asks for, checked; the value is kept only for this request. */
async function checkInput(body: unknown, hosted: boolean): Promise<Change> {
  const { action = "save", name, value: v, label } = (body ?? {}) as Record<string, unknown>;
  insist(ACTIONS.includes(action as string), "Send JSON { action, name, value?, label? }.", 400);
  if (action === "redeploy") return { action, name: "" };
  insist(typeof name === "string" && KEY.test(name), "The key takes letters, digits and _ and cannot start with a digit.", 400);
  insist(!refusedName(name, hosted), `${name} is set by Revbound, Vercel or an integration, not here.`, 400);
  insist(label === undefined || (typeof label === "string" && label.trim().length <= 256 && !/[\0-\x1f\x7f]/.test(label)),
    "The name must be one line of at most 256 characters.", 400);
  insist(action !== "rename" || (label as string | undefined)?.trim(), "Send the new name.", 400);
  if (action === "save") {
    insist(typeof v === "string", "Send JSON { name, value }.", 400);
    const bad = checkValue(v);
    insist(!bad, bad!, 400);
  }
  return { action: action as Change["action"], name, value: action === "save" ? (v as string) : undefined, label: (label as string | undefined)?.trim() };
}

/** Locally: .env.local holds the value, .env.example the name and its label. */
async function changeLocal(c: Change): Promise<Done> {
  const { envLocalNames, exampleConnections } = await import("revbound/kit/dotenv");
  insist(c.action !== "redeploy", "Nothing redeploys on this computer.", 400);
  const dir = process.cwd(), shell = (value("REVBOUND_SHELL_KEYS") ?? "").split(",").includes(c.name);
  if (c.action === "delete") {
    insist(envLocalNames().includes(c.name) || exampleConnections().some((e) => e.name === c.name), `${c.name} is not set here.`, 404);
    writeEnvLocal(dir, c.name, null);
    writeExample(dir, c.name, null);
    return { ok: true, status: "Deleted.", shell };
  }
  if (c.action === "save") writeEnvLocal(dir, c.name, c.value!);
  writeExample(dir, c.name, c.label ?? "");
  return { ok: true, status: c.action === "save" ? "Saved." : "Renamed.", shell };
}

/**
 * POST /connections/change { action: "save" | "rename" | "delete" | "redeploy", name, value?, label? } from the console's own
 * page: locally .env.local and .env.example, hosted Vercel's Production env. Values are never logged, echoed or kept.
 */
export async function change(req: Request): Promise<Response> {
  const hosted = isHosted();
  try {
    insist(req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json", "Send JSON { action, name, value?, label? }.", 415);
    const { save, session } = await access(req);
    if (hosted) {
      insist(session, save.reason ?? "Keys can't be changed here; change them in Vercel.");
      insist(req.headers.get("origin") === session.origin && req.headers.get("sec-fetch-site") === "same-origin" &&
        safeEqual(req.headers.get("x-revbound-csrf"), session.csrf), "The change was refused; reload the page and try again.");
    }
    const c = await checkInput(await req.json().catch(() => undefined), hosted);
    const done = session ? await changeHosted(session, c) : await changeLocal(c);
    c.value = undefined;
    return reply(done);
  } catch (error) {
    if (error instanceof Refused) return reply({ error: error.message }, error.status);
    console.error("[revbound] connections change failed:", error instanceof Error ? error.name : "unknown error");
    return reply({ error: "The change failed." }, 500);
  }
}
