import type { Ctx, DatabaseSlotV1 } from "revbound";
export default function swapped(ctx: Ctx): DatabaseSlotV1 & { swapped: true };
