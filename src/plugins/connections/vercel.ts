/**
 * Hosted key changes: the project's Production variables through the Vercel API, with a project-scoped token
 * (REVBOUND_VERCEL_TOKEN), only on the production domain and only for a browser signed in through Vercel's login.
 */
import { createHmac } from "node:crypto";
import { basePath, jwtClaims, PROBE_PATH, PROTECTED_STATUSES, requestHost, value, vercelJwts } from "revbound/kit";
import { refusedName } from "./files.js";

/** The fixed contents of `public/_revbound/probe.txt`. */
const PROBE_TEXT = "revbound-probe-v1";
const PRIVATE = "Changes need a browser signed in through Vercel's login on this domain.";
const enc = encodeURIComponent;

/** A refusal the route answers with this status and message (never a value). */
export class Refused extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}
export function insist(ok: unknown, message: string, status = 403): asserts ok {
  if (!ok) throw new Refused(message, status);
}

/** A Vercel REST call with the token; failures carry the status and Vercel's error code, never the body. */
async function vercel<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
  const res = await fetch(`https://api.vercel.com${path}`, {
    method, body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Refused("Could not reach Vercel; try again.", 502); });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string } };
  if (!res.ok) throw new Refused(`Vercel refused the change (${res.status}${data.error?.code ? ` ${data.error.code}` : ""}).`, 502);
  return data;
}

export type Session = { origin: string; token: string; projectId: string; team: string; csrf: string };
export type Save = { mode: "local" | "hosted" | "link" | "off"; reason?: string; csrf?: string };

let teamCache: string | undefined;
/** The project's team (accountId), looked up once per instance. */
async function teamId(token: string, projectId: string): Promise<string> {
  teamCache ??= (await vercel<{ accountId: string }>(token, `/v9/projects/${enc(projectId)}`)).accountId;
  insist(teamCache, "Vercel did not name this project's team.", 502);
  return teamCache;
}

/**
 * The cookie shape is a fail-closed compatibility check, not a signature check: Vercel itself validates the session
 * when the probe is requested with it, and an anonymous probe must be refused, so turning Deployment Protection off
 * turns hosted changes off. Bypass, bearer and trusted-OIDC callers have no owner session.
 */
async function ownerSession(req: Request, origin: string, team: string): Promise<string> {
  const keys = [...new URL(req.url).searchParams.keys()].map((k) => k.toLowerCase());
  for (const name of ["authorization", "x-vercel-protection-bypass", "x-vercel-set-bypass-cookie", "x-vercel-trusted-oidc-idp-token"]) {
    insist(!req.headers.has(name) && !keys.includes(name), PRIVATE);
  }
  const jwts = vercelJwts(req), [jwt] = jwts;
  insist(jwts.length === 1 && jwt.length < 8192 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt), PRIVATE);
  const claims = jwtClaims(jwt);
  insist(!Object.hasOwn(claims, "bypass") && typeof claims.userId === "string" && claims.userId.length > 0 &&
    claims.ownerId === team && claims.aud === new URL(origin).hostname && claims.sub === "sso-protection", PRIVATE);
  const probe = (headers?: Record<string, string>) =>
    fetch(`${origin}${basePath()}${PROBE_PATH}`, { redirect: "manual", cache: "no-store", headers, signal: AbortSignal.timeout(10_000) });
  const [anonymous, signedIn] = await Promise.all([probe(), probe({ cookie: `_vercel_jwt=${jwt}` })]).catch(() => {
    throw new Refused("Could not check the Vercel login right now; try again.", 503);
  });
  try {
    insist(PROTECTED_STATUSES.includes(anonymous.status), "Turn on Vercel Authentication → All Deployments to change keys here.");
    insist(signedIn.status === 200 && (await signedIn.text()).trim() === PROBE_TEXT, PRIVATE);
  } finally { await anonymous.body?.cancel(); if (!signedIn.bodyUsed) await signedIn.body?.cancel(); }
  return jwt;
}

/** How changes work for this hosted request: only on the production domain, with the token and a verified owner session. */
export async function hostedAccess(req: Request): Promise<{ save: Save; session?: Session }> {
  const prod = value("VERCEL_PROJECT_PRODUCTION_URL")?.toLowerCase();
  if (process.env.VERCEL_ENV !== "production" || !prod || requestHost(req) !== prod) {
    const where = prod && /^[a-z0-9.-]+(:\d+)?$/.test(prod) ? ` (https://${prod})` : "";
    return { save: { mode: "off", reason: `Keys can be changed only on the production domain${where}.` } };
  }
  const token = value("REVBOUND_VERCEL_TOKEN"), projectId = value("VERCEL_PROJECT_ID");
  if (!token || !projectId) return { save: { mode: "link" } };
  const origin = `https://${prod}`;
  try {
    const team = await teamId(token, projectId), jwt = await ownerSession(req, origin, team);
    const csrf = createHmac("sha256", token).update(`connections-v1:${origin}:${jwt}`).digest("base64url");
    return { save: { mode: "hosted", csrf }, session: { origin, token, projectId, team, csrf } };
  } catch (error) {
    if (error instanceof Refused) return { save: { mode: "off", reason: error.message } };
    throw error;
  }
}

type EnvVar = { id: string; key: string; type?: string; target?: string[] | string; customEnvironmentIds?: string[]; gitBranch?: string;
  comment?: string; configurationId?: string | null; integrationId?: string; sharedEnvVariableId?: string; system?: boolean };
export type Production = { id: string; comment: string; editable: boolean };

/**
 * The project's Production variables by name, never values. Editable: the variable is Production's alone and the
 * project's own; one shared with other environments, an integration's, a shared or a system one is changed in Vercel.
 */
export async function productionVars(token: string, projectId: string): Promise<Map<string, Production>> {
  const team = await teamId(token, projectId);
  const { envs = [] } = await vercel<{ envs?: EnvVar[] }>(token, `/v10/projects/${enc(projectId)}/env?teamId=${enc(team)}`);
  const prod = envs.filter((e) => [e.target ?? []].flat().includes("production") && !refusedName(e.key, true));
  return new Map(prod.map((e) => [e.key, {
    id: e.id, comment: typeof e.comment === "string" ? e.comment.slice(0, 256) : "",
    editable: [e.target].flat().length === 1 && !e.customEnvironmentIds?.length && !e.gitBranch && !e.configurationId && !e.integrationId &&
      !e.sharedEnvVariableId && !e.system && e.type !== "system" && prod.filter((o) => o.key === e.key).length === 1,
  }]));
}

/** A banner from 14 days before REVBOUND_VERCEL_TOKEN_EXPIRES (or after it), else null. */
export function tokenWarning(now = Date.now()): string | null {
  const expires = value("REVBOUND_VERCEL_TOKEN_EXPIRES");
  if (!expires || !value("REVBOUND_VERCEL_TOKEN")) return null;
  const at = Date.parse(expires), fix = "Ask your agent to replace it with a new project token.";
  if (Number.isNaN(at)) return `The Vercel token's expiry date (${expires}) is not a date. ${fix}`;
  const days = Math.ceil((at - now) / 86_400_000);
  if (days > 14) return null;
  return `${days <= 0 ? "The Vercel token for changing keys has expired" : `The Vercel token for changing keys expires in ${days} day${days === 1 ? "" : "s"}`}. ${fix}`;
}

export type Change = { action: "save" | "rename" | "delete" | "redeploy"; name: string; value?: string; label?: string };
export type Done = { ok: true; status: string; redeploy?: "started" | "skipped" | "failed"; shell?: boolean };

/** Redeploys the newest production deployment so it picks up Production's variables; `done` opens the status. */
async function redeploy(s: Session, done: string): Promise<Done> {
  const id = enc(s.projectId), team = `teamId=${enc(s.team)}`, then = (text: string) => `${done ? `${done} ` : ""}${text}`;
  const project = await vercel<{ name: string; autoAssignCustomDomains?: boolean }>(s.token, `/v9/projects/${id}?${team}`);
  // An Instant Rollback pins production: Vercel turns production auto-assign off until it is undone.
  if (project.autoAssignCustomDomains === false) {
    return { ok: true, redeploy: "skipped", status: then("Production is pinned by a rollback, so nothing was redeployed. Undo the rollback in Vercel, then redeploy.") };
  }
  const { deployments = [] } = await vercel<{ deployments?: { uid: string; readyState?: string }[] }>(s.token,
    `/v6/deployments?projectId=${id}&target=production&limit=10&${team}`);
  // Even a build already in flight keeps the old value, so the newest deployable one is redeployed whatever its state.
  const newest = deployments.find((d) => ["READY", "BUILDING", "INITIALIZING", "QUEUED"].includes(d.readyState ?? ""));
  if (!newest) return { ok: true, status: then("There is no production deployment to redeploy yet; the next one uses it.") };
  const created = await vercel(s.token, `/v13/deployments?${team}`, { body: { name: project.name, deploymentId: newest.uid, target: "production" } })
    .catch((e: Error) => e);
  if (created instanceof Error) return { ok: true, redeploy: "failed", status: then(`The redeploy failed: ${created.message}`) };
  return { ok: true, redeploy: "started", status: then("Production is redeploying; your workflows use it in about a minute.") };
}

/**
 * save upserts the Production-only Sensitive variable with the label as its Note, rename changes only the Note, delete
 * removes it; save and delete then redeploy, and redeploy retries only that. Others' variables are refused.
 */
export async function changeHosted(s: Session, c: Change): Promise<Done> {
  if (c.action === "redeploy") return redeploy(s, "");
  const row = (await productionVars(s.token, s.projectId)).get(c.name), team = `teamId=${enc(s.team)}`;
  const base = `/v9/projects/${enc(s.projectId)}/env`;
  // Upsert would split a production variable shared with other environments, so those are refused.
  insist(!row || row.editable, `${c.name} is shared with other environments or owned by Vercel or an integration; change it in Vercel.`, 409);
  if (c.action !== "save") insist(row, `${c.name} is not set in Production yet; add it first.`, 404);
  if (c.action === "rename") {
    await vercel(s.token, `${base}/${enc(row!.id)}?${team}`, { method: "PATCH", body: { comment: c.label } });
    return { ok: true, status: "Renamed." };
  }
  if (c.action === "delete") {
    await vercel(s.token, `${base}/${enc(row!.id)}?${team}`, { method: "DELETE" });
    return redeploy(s, "Deleted.");
  }
  const comment = c.label || row?.comment;
  await vercel(s.token, `/v10/projects/${enc(s.projectId)}/env?upsert=true&${team}`,
    { body: { key: c.name, value: c.value, type: "sensitive", target: ["production"], ...(comment && { comment }) } });
  return redeploy(s, "Saved.");
}
