/**
 * Request shapes shared by the proxy and the API router: Vercel's protection bypass, its `_vercel_jwt` cookie
 * and the fail-closed probe. No imports, so it is safe in the proxy and in workflow scope.
 */
export const BYPASS = "x-vercel-protection-bypass";
const SET_BYPASS_COOKIE = "x-vercel-set-bypass-cookie";
/** Served from `public/`, outside the proxy's matcher; requested by the fail-closed probe. */
export const PROBE_PATH = "/_revbound/probe.txt";
/** Statuses that show Vercel's login stands in front of an anonymous request. */
export const PROTECTED_STATUSES = [301, 302, 303, 307, 308, 401, 403];

/** The request's Host header, lower-cased, port included. */
export const requestHost = (req: Request) => (req.headers.get("host") ?? "").toLowerCase();

/** A JWT's payload claims ({} if it does not decode). atob, not Buffer, so it runs in workflow scope; compared claims are ASCII. */
export function jwtClaims(jwt: string): Record<string, unknown> {
  try { return JSON.parse(atob((jwt.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) ?? {}; } catch { return {}; }
}

/** Every `_vercel_jwt` cookie value on the request: Vercel's login session or a bypass cookie. */
export const vercelJwts = (req: Request) =>
  (req.headers.get("cookie") ?? "").split(";").map((c) => c.trim()).filter((c) => c.startsWith("_vercel_jwt=")).map((c) => c.slice(12));

export type Bypass = { header?: string; query: string[]; cookie: boolean };

/**
 * The Protection Bypass a request carries, if any: the `x-vercel-protection-bypass` header or query parameter (any
 * case), or a bypass cookie, a `_vercel_jwt` (the login session's name; its sub is "sso-protection")
 * with a `bypass` claim and sub "protection-bypass-automation" or, for Shareable Links, "protection-bypass-url".
 * A request asking for the cookie (`x-vercel-set-bypass-cookie`) counts as one too.
 */
export function carriesBypass(req: Request): Bypass | undefined {
  const params = [...new URL(req.url).searchParams].map(([k, v]) => [k.toLowerCase(), v]);
  const query = params.filter(([k]) => k === BYPASS).map(([, v]) => v);
  const cookie = req.headers.has(SET_BYPASS_COOKIE) || params.some(([k]) => k === SET_BYPASS_COOKIE) ||
    vercelJwts(req).map(jwtClaims).some((c) => Object.hasOwn(c, "bypass") || String(c.sub).startsWith("protection-bypass"));
  if (!req.headers.has(BYPASS) && !query.length && !cookie) return undefined;
  return { header: req.headers.get(BYPASS) ?? undefined, query, cookie };
}
