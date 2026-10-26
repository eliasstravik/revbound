/** The mdm suite on real Postgres: REVBOUND_TEST_PG_URL (CI's service container), in a fresh database. Skipped without it. */
import { test } from "node:test";
import pg from "pg";
import { suite } from "./suite.mjs";

const base = process.env.REVBOUND_TEST_PG_URL;
if (!base) test("mdm on Postgres", { skip: "set REVBOUND_TEST_PG_URL to a Postgres 16 server" }, () => {});
else {
  const name = `revbound_mdm_test_${Date.now().toString(36)}`, admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await suite({ url: url.toString(), concurrent: true });
}
