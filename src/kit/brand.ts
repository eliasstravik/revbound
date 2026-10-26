/** The brand every `signature` route handler and every webhook() carries. Symbol.for, so copies of the package agree. */
export const WEBHOOK: unique symbol = Symbol.for("revbound/webhook") as never;

export const isBranded = (value: unknown): boolean =>
  (typeof value === "function" || (typeof value === "object" && value !== null)) && (value as Record<symbol, unknown>)[WEBHOOK] === true;

/** Marks `value` as built by webhook(). */
export function brand<T extends object>(value: T): T {
  Object.defineProperty(value, WEBHOOK, { value: true });
  return value;
}
