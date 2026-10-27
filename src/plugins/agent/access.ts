/**
 * Who may open the agent's session endpoint (/eve/v1/*): exactly whoever may open the console, and no one else. Hosted,
 * that is a person past Vercel Authentication carrying no bypass credential of any kind, on a deployment where Vercel
 * Authentication is on; locally, the computer running `revbound dev`, or a Tailscale login on one of its allowed hosts
 * (the chat runs on this computer's own AI login, so an allowed host alone is not enough, as for `tailnet` routes).
 * Writes must come from the console's own page. No Vercel OIDC token, bypass secret or eve dev login opens it.
 */
import { allowedHosts, carriesBypass, isHosted, jwtClaims, LOOPBACK_HOSTS, loopback, pageAccess, sameOrigin, tailnetLogin, vercelJwts, type Env } from "revbound/kit";

export type Caller = { ok: true; principalId: string; attributes: Record<string, string> } | { ok: false; status: number; error: string };

const hostOf = (h: string | null) => (h ?? "").split(",")[0].trim().toLowerCase();

/**
 * Locally the request reaches eve's dev server through Next's rewrite, which may set Host to that server; the host the
 * browser used is then in X-Forwarded-Host. The page rule is checked against the browser's host.
 */
function asBrowserSaw(req: Request): Request {
  const host = hostOf(req.headers.get("host")), forwarded = hostOf(req.headers.get("x-forwarded-host"));
  if (!forwarded || !LOOPBACK_HOSTS.includes(host.replace(/:\d+$/, ""))) return req;
  const headers = new Headers(req.headers);
  headers.set("host", forwarded);
  return new Request(req.url, { method: req.method, headers });
}

/** Credentials Vercel's edge may take instead of the login cookie; with one, the cookie proves no one. */
const OTHER_CREDENTIALS = ["authorization", "x-vercel-trusted-oidc-idp-token"];

/**
 * The Vercel login behind a hosted request: the `userId` of its `_vercel_jwt` login cookie (sub "sso-protection", for
 * this host), which Vercel's edge has checked. Undefined unless that cookie is the request's only credential: the edge
 * lets a request through when any one of several cookies is valid, so a second, forged one could name someone else.
 */
export function vercelUser(req: Request): string | undefined {
  const jwts = vercelJwts(req);
  if (jwts.length !== 1 || OTHER_CREDENTIALS.some((h) => req.headers.has(h))) return undefined;
  const claims = jwtClaims(jwts[0]);
  if (claims.sub !== "sso-protection" || claims.aud !== hostOf(req.headers.get("host")).replace(/:\d+$/, "")) return undefined;
  return typeof claims.userId === "string" && claims.userId ? `vercel:${claims.userId}` : undefined;
}

/** Whether `req` may use the console chat, and as whom. Pure: the fail-closed probe is the caller's (consoleAuth). */
export function consoleCaller(req: Request, env: Env = process.env): Caller {
  if (isHosted(env)) {
    if (carriesBypass(req)) return { ok: false, status: 403, error: "Requests carrying a protection bypass cannot open the console." };
    if (!sameOrigin(req, hostOf(req.headers.get("host")))) return { ok: false, status: 403, error: "Cross-site requests are refused." };
    const user = vercelUser(req);
    if (!user) return { ok: false, status: 403, error: "Sign in to Vercel again to use the chat." };
    return { ok: true, principalId: user, attributes: { via: "vercel" } };
  }
  const seen = asBrowserSaw(req), verdict = pageAccess(seen, env);
  if (!verdict.ok) return verdict;
  const host = hostOf(seen.headers.get("host"));
  if (![...LOOPBACK_HOSTS, ...allowedHosts(env)].includes(host.replace(/:\d+$/, "")) || !sameOrigin(seen, host)) {
    return { ok: false, status: 403, error: "Cross-site requests are refused." };
  }
  const login = tailnetLogin(seen, env);
  if (!login && !loopback(seen)) return { ok: false, status: 403, error: "The chat answers only on the computer running npm run dev, or to a Tailscale login on its name." };
  // Locally there is one person: the computer's owner, at the computer or on their own tailnet.
  return { ok: true, principalId: "local", attributes: login ? { via: "tailnet", login } : { via: "local" } };
}
