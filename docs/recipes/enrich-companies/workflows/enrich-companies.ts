import { agent } from "#revbound/ai";
import { db } from "#revbound/database";
import { currentRun } from "#revbound/workflows";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { companies, companyProfiles } from "../db/schema";

const Profile = z.object({
  description: z.string().nullable(),
  industry: z.string().nullable(),
  businessType: z.string().nullable(),
  location: z.string().nullable(),
});
type Profile = z.infer<typeof Profile>;

/** Saved companies without a profile from the last `freshDays`, oldest first. */
async function pickDomains(limit: number, freshDays: number) {
  "use step";
  const rows = await db().select({ domain: companies.domain }).from(companies)
    .leftJoin(companyProfiles, and(eq(companyProfiles.domain, companies.domain),
      sql`${companyProfiles.enrichedAt} > now() - make_interval(days => ${freshDays})`))
    .where(isNull(companyProfiles.domain)).orderBy(companies.savedAt).limit(limit);
  return rows.map((r) => r.domain);
}

async function saveProfile(domain: string, profile: Profile, costUsd: number) {
  "use step";
  const values = { ...profile, costUsd, enrichedAt: new Date() };
  await db().insert(companyProfiles).values({ domain, ...values }).onConflictDoUpdate({ target: companyProfiles.domain, set: values });
}

/**
 * Reads each saved company's website into a short profile. `limit` caps the companies per run (keep it near 20; docs:
 * workflows, run size). A preview (`revbound run enrich-companies --preview`) reads one company, so its result carries a
 * sample and its cost.
 */
export async function enrichCompanies(input?: { limit?: number; freshDays?: number }) {
  "use workflow";
  const { preview } = await currentRun();
  const domains = await pickDomains(preview ? 1 : Math.min(input?.limit ?? 20, 20), input?.freshDays ?? 30);
  const sample: (Profile & { domain: string })[] = [];
  let costUsd = 0;
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const domain of domains) {
    const result = await agent({
      name: "enrichCompany",
      instructions: "Read the company's own website and describe the company. Use only what the site says; null when it does not say.",
      prompt: `Company website: https://${domain}\nReturn its one-sentence description, industry, business type (B2B, B2C, marketplace or the like) and headquarters location.`,
      schema: Profile,
      tools: { web: { fetch: true } },
      maxSteps: 6,
    });
    await saveProfile(domain, result.value, result.costUsd);
    costUsd += result.costUsd;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (sample.length < 3) sample.push({ domain, ...result.value });
  }
  return { enriched: domains.length, sample, costUsd, usage };
}
