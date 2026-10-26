// A DatabaseSlotV1 provider that wraps the default one and marks itself.
import provide from "revbound/database/provide";

export default function swapped(ctx) {
  const inner = provide(ctx);
  globalThis.__revboundSwappedDatabase = true;
  return { ...inner, swapped: true };
}
