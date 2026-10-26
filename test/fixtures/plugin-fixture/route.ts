import { sql } from "drizzle-orm";
import type { RouteCtx } from "revbound";

export default async function hello(_req: Request, ctx: RouteCtx): Promise<Response> {
  const { rows } = await ctx.get("database").db().execute(sql`select count(*)::int as n from gtm_fixture.notes`);
  return Response.json({ hello: "fixture", notes: rows[0].n, plugin: ctx.plugin });
}
