import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "..", "deploy", "migrations");

async function run() {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
  )`;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await sql`
      SELECT version FROM schema_migrations WHERE version = ${version}
    `;
    if (applied.length > 0) {
      console.log(`[migrate] skip ${version} (already applied)`);
      continue;
    }
    const content = await readFile(join(migrationsDir, file), "utf8");
    console.log(`[migrate] apply ${version}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      // ON CONFLICT covers two cases: (1) the SQL file itself records
      // its own version (legacy migrations 001+ do this), (2) a previous
      // partially-failed run got past the SQL but crashed before
      // returning. Either way: row already there, no-op safely.
      await tx`INSERT INTO schema_migrations (version) VALUES (${version}) ON CONFLICT (version) DO NOTHING`;
    });
  }

  await sql.end();
  console.log("[migrate] done");
}

run().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
