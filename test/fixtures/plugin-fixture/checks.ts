import type { CheckResult } from "revbound";

export default async function checks(): Promise<CheckResult[]> {
  return [{ level: "info", message: "Fixture: its check ran." }];
}
