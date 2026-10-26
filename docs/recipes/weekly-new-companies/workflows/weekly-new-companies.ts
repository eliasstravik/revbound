import { db } from "#revbound/database";
import { sql } from "drizzle-orm";
import { companies, weeklyNewCompanies } from "../db/schema";

/** Counts the companies saved in the 7 days before this run and keeps the count, one row per week. */
async function countWeek() {
  "use step";
  const [{ weekStart, count }] = (await db().execute(sql`
    select to_char(date_trunc('week', now() - interval '7 days'), 'YYYY-MM-DD') as "weekStart",
      count(*)::int as count from ${companies} where ${companies.savedAt} > now() - interval '7 days'`)).rows as { weekStart: string; count: number }[];
  await db().insert(weeklyNewCompanies).values({ weekStart, companies: count })
    .onConflictDoUpdate({ target: weeklyNewCompanies.weekStart, set: { companies: count, countedAt: new Date() } });
  return { weekStart, companies: count };
}

/** Weekly: how many companies came in last week. A cron run gets no input. */
export async function weeklyNewCompaniesCount() {
  "use workflow";
  return await countWeek();
}
