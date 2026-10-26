// A third-party plugin package: one session route and a docs topic, plus a swap for the default database plugin.
import { database } from "revbound/database";

export function packaged() {
  return {
    name: "packaged",
    api: 1,
    routes: [{ path: "packaged/hello", methods: ["GET"], access: "session", handler: "gtm-plugin-fixture/route" }],
    docs: { packaged: "gtm-plugin-fixture/docs.md" },
  };
}

/** The database plugin with another provider of the same slot interface. */
export function swappedDatabase() {
  return { ...database(), provide: "gtm-plugin-fixture/database" };
}
