/**
 * Calls this project's own Revbound API (`/api/revbound/*`), the routes `revbound run` uses, so every run the agent
 * starts goes through the workflows slot and the ledger and shows in the console. Hosted: this deployment's own domain
 * (production's on production) with the Protection Bypass for Automation secret, which the `automation` routes take.
 * Locally: `revbound dev` on 127.0.0.1. The secret stays in this process: never in the sandbox or the model's view.
 */
import { basePath, isHosted, value, type Env } from "revbound/kit";

/**
 * Whether the agent is built or served by Vercel, where it gets the cloud sandbox and the deployed instructions. Not
 * under `revbound dev`, even when `vercel env pull` put VERCEL=1 in .env.local.
 */
export const onVercel = (env: Env = process.env) => Boolean(env.VERCEL) && env.REVBOUND_DEV !== "1";

export const NO_BYPASS = "Starting runs from the deployed agent needs Protection Bypass for Automation (Project Settings → Deployment Protection) " +
  "and the system environment variables exposed; turn them on and redeploy (`npx revbound docs deploy`).";

/** Where the app's API is and the headers it needs; throws a message the model can pass on. */
export function appBase(env: Env = process.env): { base: string; headers: Record<string, string> } {
  if (!isHosted(env)) return { base: `http://127.0.0.1:${value("REVBOUND_PORT", env) ?? 3000}${basePath(env)}`, headers: {} };
  const secret = value("VERCEL_AUTOMATION_BYPASS_SECRET", env);
  const domain = env.VERCEL_ENV === "production" ? value("VERCEL_PROJECT_PRODUCTION_URL", env) : value("VERCEL_URL", env);
  if (!secret || !domain) throw new Error(NO_BYPASS);
  return { base: `https://${domain}${basePath(env)}`, headers: { "x-vercel-protection-bypass": secret } };
}

/** One call to `/api/revbound<path>`; a refusal throws with the app's own reason. */
export async function appApi(path: string, init: RequestInit = {}, env: Env = process.env): Promise<any> {
  const { base, headers } = appBase(env);
  const res = await fetch(`${base}/api/revbound${path}`, {
    ...init, redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) },
  }).catch((error: Error) => {
    throw new Error(isHosted(env) ? `The app did not answer: ${error.message}` : "The app is not running here: start `npm run dev`.");
  });
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new Error(NO_BYPASS);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `The app answered ${res.status}.`);
  return body;
}
