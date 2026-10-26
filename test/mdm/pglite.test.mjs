/** The mdm suite on PGlite as revbound dev serves it (one shared session: its socket queue serializes transactions). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { suite } from "./suite.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const { startDevDatabase } = await import(path.join(REPO, "dist", "plugins", "database", "localdb.js"));
const dir = fs.mkdtempSync(path.join(process.env.REVBOUND_TEST_DIR ?? os.tmpdir(), "revbound-mdm-pglite-"));
const local = await startDevDatabase(dir);
after(() => local.stop());
await suite({ url: local.url, concurrent: false });
