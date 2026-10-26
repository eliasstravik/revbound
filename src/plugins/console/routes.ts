/** GET /shell (session) → { company, environment, deployment }: `deployment` changes with every deploy, so open pages reload. */
import type { RouteCtx } from "revbound";
import { environment, json } from "revbound/kit";

export function shell(_req: Request, ctx: RouteCtx): Response {
  return json({ company: ctx.manifest.company, environment: environment(), deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null });
}
