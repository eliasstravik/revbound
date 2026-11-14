/** Serves a fresh local database as `revbound dev` does, in its own process (as under dev, where the app connects over TCP); sends its URL to the parent. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { startDevDatabase } = await import(path.join(process.argv[2], "dist", "plugins", "database", "localdb.js"));
const local = await startDevDatabase(fs.mkdtempSync(path.join(process.env.REVBOUND_TEST_DIR ?? os.tmpdir(), "revbound-localdb-")));
process.send(local.url);
process.on("disconnect", () => local.stop().finally(() => process.exit(0)));
