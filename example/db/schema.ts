// Drizzle tables owned by workflows, in schema `public` (plugins keep their own schemas).
// After a change: `npm run db:generate`, then `npm run db:migrate`.
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/** An example from `revbound init --example` (workflows/example-import.ts). */
export const exampleCompanies = pgTable("example_companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
});
