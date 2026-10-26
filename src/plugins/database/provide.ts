/** The `database` slot (DatabaseSlotV1): db(), migrate(plan) and stamp(). */
import type { Ctx, DatabaseSlotV1 } from "revbound";
import { db } from "./runtime.js";
import { applyPlan, stamp } from "./migrate.js";

export default function provide(_ctx: Ctx): DatabaseSlotV1 {
  return { db, migrate: applyPlan, stamp };
}
