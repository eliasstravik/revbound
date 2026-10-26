/**
 * Environment rules shared by every entry point. Pure: no Node imports, so it is safe in the proxy,
 * in route handlers and in workflow scope.
 */
export type Env = Record<string, string | undefined>;

/** What `vercel env pull` writes for a Secret value it cannot read. It counts as missing everywhere. */
export const PULL_PLACEHOLDER = "[SENSITIVE]";

/** A variable's value, or undefined when it is unset, empty or Vercel's pull placeholder. */
export function value(name: string, env: Env = process.env): string | undefined {
  const v = env[name];
  return v == null || v === "" || v === PULL_PLACEHOLDER ? undefined : v;
}

/**
 * Hosted means a Vercel deployment: VERCEL_ENV preview or production plus VERCEL_DEPLOYMENT_ID, which only
 * deployments carry (`vercel env pull` never writes it). Anything under `next dev` (and so `revbound dev`) is never hosted.
 */
export function isHosted(env: Env = process.env): boolean {
  if (env.NODE_ENV === "development" || env.GTM_DEV === "1") return false;
  return (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production") && value("VERCEL_DEPLOYMENT_ID", env) != null;
}

export type Environment = "local" | "preview" | "production";

export function environment(env: Env = process.env): Environment {
  return isHosted(env) ? (env.VERCEL_ENV as "preview" | "production") : "local";
}

/** The local app port: GTM_PORT, default 3000. */
export function appPort(env: Env = process.env): number {
  const port = Number(value("GTM_PORT", env) ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`GTM_PORT must be a port number, not ${env.GTM_PORT}`);
  return port;
}

/**
 * The app's sub-path, "" at the root: GTM_BASE_PATH (e.g. `/acme`, to share the local Console under a path), which
 * withGtm makes Next's basePath. Inside Next it is the value Next inlined at build.
 */
export function basePath(env: Env = process.env): string {
  return process.env.__NEXT_ROUTER_BASEPATH || value("GTM_BASE_PATH", env) || "";
}

/** Private hostnames the person admits to the local Console (GTM_ALLOWED_HOSTS, comma-separated, off by default). */
export function allowedHosts(env: Env = process.env): string[] {
  return (value("GTM_ALLOWED_HOSTS", env) ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** The hosts that always reach the local Console. */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

/** Constant-time string comparison; false when either side is missing. */
export function safeEqual(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The database's identity, which the production stamp names: for Neon the endpoint id (the first host label with
 * `-pooler` removed, so pooled and unpooled URLs match), else the host.
 */
export function databaseIdentity(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.endsWith(".neon.tech") ? host.split(".")[0].replace(/-pooler$/, "") : host;
}

export const PRODUCTION_DATABASE =
  "This is production's database; connect a dev branch instead (see `npx revbound docs data`).";

/**
 * The stamp check used by db(), `revbound migrate` and `revbound dev`. `query` runs one SQL statement and returns its rows.
 * A database whose `gtm.meta` stamp names its own identity is refused unless this is hosted production.
 */
export async function assertNotProduction(query: (sql: string) => Promise<{ value: string }[]>, url: string,
  env: Env = process.env): Promise<void> {
  if (isHosted(env) && env.VERCEL_ENV === "production") return;
  const rows = await query("select value from gtm.meta where key = 'production'").catch((error: { code?: string }) => {
    if (error?.code === "42P01" || error?.code === "3F000") return []; // gtm.meta or schema gtm not created yet
    throw error;
  });
  if (rows.some((r) => r.value === databaseIdentity(url))) throw new Error(PRODUCTION_DATABASE);
}
