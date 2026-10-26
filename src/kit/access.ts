/**
 * The access modes every route declares, and the page rule. Pure (no imports beyond env and request rules), so the
 * proxy and the route shim run the same checks.
 */
import type { Access } from "../core/types.js";
import { allowedHosts, type Env, isHosted, LOOPBACK_HOSTS, safeEqual, value } from "./env.js";
import { type Bypass, carriesBypass, requestHost } from "./request.js";

export type Verdict = { ok: true } | { ok: false; status: number; error: string };

const OK: Verdict = { ok: true };
const no = (status: number, error: string): Verdict => ({ ok: false, status, error });
const hostOf = (h: string) => h.split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();

/** The full local check: loopback Host and X-Forwarded-Host, a loopback or absent Origin, Sec-Fetch-Site same-origin or absent. */
export function loopback(req: Request): boolean {
  const [host, forwarded, origin, site] = ["host", "x-forwarded-host", "origin", "sec-fetch-site"].map((h) => req.headers.get(h));
  const local = (h: string | null) => !h || LOOPBACK_HOSTS.includes(hostOf(h));
  if (!host || !local(host) || !local(forwarded)) return false;
  if (origin && !(URL.canParse(origin) && LOOPBACK_HOSTS.includes(new URL(origin).hostname))) return false;
  return !site || site === "same-origin" || site === "none";
}

/** Locally: a loopback or REVBOUND_ALLOWED_HOSTS host, and no cross-site write. */
function localHost(req: Request, env: Env): Verdict {
  const host = requestHost(req);
  if (![...LOOPBACK_HOSTS, ...allowedHosts(env)].includes(host.replace(/:\d+$/, ""))) {
    return no(403, "This host is not allowed. To admit a private hostname, add it to REVBOUND_ALLOWED_HOSTS.");
  }
  if (req.method === "GET" || req.method === "HEAD") return OK;
  const site = req.headers.get("sec-fetch-site"), origin = req.headers.get("origin");
  const originHost = origin === null ? host : URL.canParse(origin) ? new URL(origin).host.toLowerCase() : "";
  return site === "cross-site" || site === "same-site" || originHost !== host ? no(403, "Cross-site requests are refused.") : OK;
}

/**
 * The Tailscale login Serve put on a same-origin request to an allowed (non-loopback) host, never a Funnel one; undefined
 * otherwise and whenever hosted. Serve sets the header itself, and revbound dev listens on 127.0.0.1 only.
 */
export function tailnetLogin(req: Request, env: Env = process.env): string | undefined {
  const login = req.headers.get("tailscale-user-login")?.trim().toLowerCase();
  if (!login || req.headers.has("tailscale-funnel-request") || isHosted(env) || LOOPBACK_HOSTS.includes(hostOf(requestHost(req)))) return undefined;
  return localHost(req, env).ok ? login : undefined;
}

/** Pages and `session` routes: hosted, Vercel Authentication in front and no bypass credential of any kind. */
export function pageAccess(req: Request, env: Env = process.env): Verdict {
  if (!isHosted(env)) return localHost(req, env);
  return carriesBypass(req) ? no(403, "Requests carrying a protection bypass cannot open the console.") : OK;
}

/** The one bypass value a sender gave (header or query, not the cookie form), or undefined. */
function single(b: Bypass): string | undefined {
  if (b.cookie) return undefined;
  const given = [...new Set([...(b.header === undefined ? [] : [b.header]), ...b.query])];
  return given.length === 1 && given[0] !== "" ? given[0] : undefined;
}

/** A `signature` route's secret variable, with `{param}` filled from the path (upper-cased, `-` as `_`). */
export function secretName(template: string | undefined, params: Record<string, string>): string | undefined {
  return template?.replace(/\{(\w+)\}/g, (_, p: string) => (params[p] ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "_"));
}

/** Whether `req` may reach a route of mode `access` (`secret`: a signature route's variable, already filled in). */
export function routeAccess(access: Access, req: Request, secret?: string, env: Env = process.env): Verdict {
  const hosted = isHosted(env), bypass = carriesBypass(req), automation = value("VERCEL_AUTOMATION_BYPASS_SECRET", env);
  switch (access) {
    case "session":
      if (req.method !== "GET" && req.method !== "HEAD") return no(405, "The console is read-only.");
      return pageAccess(req, env);
    case "automation":
      if (!hosted) return loopback(req) ? OK : no(403, "This answers only on 127.0.0.1 or localhost (revbound run).");
      return bypass && !bypass.cookie && !bypass.query.length && safeEqual(bypass.header, automation) ? OK
        : no(403, "This needs the x-vercel-protection-bypass header set to the automation bypass secret (revbound run --prod).");
    case "cron": {
      if (hosted && bypass) return no(403, "Cron routes take no protection bypass.");
      const cron = value("CRON_SECRET", env);
      if (!cron) return no(401, "CRON_SECRET is not set, so cron requests are refused.");
      return safeEqual(req.headers.get("authorization"), `Bearer ${cron}`) ? OK : no(401, "Unauthorized");
    }
    case "signature": {
      if (!hosted) return loopback(req) ? OK : no(403, "Webhooks answer only on 127.0.0.1 or localhost here.");
      const given = bypass && single(bypass), expected = secret ? value(secret, env) : undefined;
      if (!given || safeEqual(given, automation)) return no(403, "A webhook needs its sender's own bypass secret.");
      return expected && safeEqual(given, expected) ? OK : no(403, "This bypass secret belongs to another sender.");
    }
    case "local":
      if (hosted) return no(404, "Not found.");
      return loopback(req) ? OK : no(403, "This answers only on 127.0.0.1 or localhost, on the computer running revbound dev.");
    case "tailnet":
      if (hosted) return no(404, "Not found.");
      return loopback(req) || tailnetLogin(req, env) ? OK : no(403, "This answers only on the computer running revbound dev, or to a Tailscale login on its name.");
    default:
      return no(500, "Unknown access mode.");
  }
}
