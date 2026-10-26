import type { Runtime } from "revbound";

export type Api = { greet(name: string): string };
export const bind = (rt: Runtime): Api => ({ greet: (name) => `hello ${name} from ${rt.plugin}` });
