import { routeAccess, pageAccess, secretName } from "../kit/access.js";
import { basePath, isHosted, LOOPBACK_HOSTS } from "../kit/env.js";
import { decodePath, find } from "../kit/patterns.js";
import { carriesBypass, PROBE_PATH, PROTECTED_STATUSES, requestHost } from "../kit/request.js";
import type { Manifest } from "./types.js";

/**
 * Whether `/.well-known/workflow/*` skips the hosted fail-closed check. False (they are checked like every page) until
 * a test shows those routes refuse outside callers on an unprotected deployment.
 */
export const WORKFLOW_ROUTES_SELF_PROTECTED = false;
const PROBE_TTL_MS = 5 * 60_000;
/** eve's session API and agent info: the routes behind which the console chat runs. */
const EVE_CONSOLE = /^\/eve\/v1\/(session|info|voice)(\/|$)/;
const PROBE_HOSTS = 32;

const NOTICE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Protection required</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem">
<h1>Turn on Vercel Authentication → All Deployments</h1>
<p>This console stays closed while this deployment can be opened without Vercel's login. In the Vercel dashboard open
Settings → Deployment Protection, set Vercel Authentication to <b>All Deployments</b> and save. This page clears
within 5 minutes.</p></body>`;

const refuse = (error: string, status = 403) =>
  Response.json({ error }, { status, headers: { "cache-control": "private, no-store" } });

const probes = new Map<string, { at: number; open: Promise<boolean> }>();

/** Whether `host` serves the probe to an anonymous caller, i.e. Vercel Authentication is off for it. Kept 5 minutes per
 * host (at most 32 hosts); a failed probe counts as unprotected and is not kept. */
export async function unprotected(host: string): Promise<boolean> {
  const hit = probes.get(host);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.open;
  probes.delete(host);
  const open = fetch(`https://${host}${basePath()}${PROBE_PATH}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000) })
    .then(async (res) => { await res.body?.cancel(); return !PROTECTED_STATUSES.includes(res.status); })
    .catch(() => { probes.delete(host); return true; });
  probes.set(host, { at: Date.now(), open });
  if (probes.size > PROBE_HOSTS) probes.delete(probes.keys().next().value!);
  return open;
}

/** Hosted pages and `session` routes answer 503 while an anonymous request gets past Vercel's login. */
export async function failClosed(req: Request): Promise<Response | undefined> {
  const host = requestHost(req);
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return refuse("Bad Host header.", 400);
  if (!(await unprotected(host))) return undefined;
  return new Response(NOTICE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * The Next.js proxy, built from the manifest's route declarations. It governs pages and `/api/*`: an `/api/*` path that
 * matches no declared route is refused, a route gets its access mode, and every page (static files included) the
 * session rule. Returns a response to stop, or undefined to continue.
 */
export function revboundProxy(manifest: Manifest) {
  return async function proxy(req: Request): Promise<Response | undefined> {
    const base = basePath(), full = new URL(req.url).pathname, hosted = isHosted();
    const path = base && full.startsWith(base) ? full.slice(base.length) || "/" : full;
    if (path === PROBE_PATH) return undefined;
    if (path.startsWith("/.well-known/workflow/")) {
      if (!hosted) {
        // The Workflow SDK's run endpoints have no check of their own; only this dev server's queue calls them, on 127.0.0.1.
        const name = (h: string) => h.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
        const host = requestHost(req), local = [host, req.headers.get("x-forwarded-host") ?? host].every((h) => LOOPBACK_HOSTS.includes(name(h)));
        return local ? undefined : refuse("Not found.", 404);
      }
      if (carriesBypass(req)) return refuse("Requests carrying a protection bypass cannot reach this.");
      return WORKFLOW_ROUTES_SELF_PROTECTED ? undefined : failClosed(req);
    }
    if (path === "/api" || path.startsWith("/api/")) {
      const parts = path.startsWith("/api/revbound/") ? decodePath(path.slice("/api/revbound/".length)) : null;
      const method = req.method === "HEAD" ? "GET" : req.method;
      const hit = parts && (find(manifest.routes, parts, (r) => (r.methods as string[]).includes(method)) ?? find(manifest.routes, parts));
      if (!hit) return refuse(`No such endpoint: ${path}`, 404);
      if (!(hit.item.methods as string[]).includes(method)) return refuse(`${req.method} is not allowed here.`, 405);
      const verdict = routeAccess(hit.item.access, req, secretName(hit.item.secret, hit.params));
      if (!verdict.ok) return refuse(verdict.error, verdict.status);
      return hosted && (hit.item.access === "session" || hit.item.access === "console") ? failClosed(req) : undefined;
    }
    // eve's routes (the agent plugin's chat): its session API is the console's, so it gets the page rule here and the
    // console rule again in eve; its other routes (health, chat apps' webhooks, callbacks) check their own credentials.
    if (path.startsWith("/eve/") && !EVE_CONSOLE.test(path)) return undefined;
    const verdict = pageAccess(req);
    if (!verdict.ok) return refuse(verdict.error, verdict.status);
    return hosted ? failClosed(req) : undefined;
  };
}
