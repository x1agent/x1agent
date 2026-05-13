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

  // Two files sharing a numeric prefix create a silent ordering trap:
  // the migrator still applies both (each filename is a distinct version
  // string), but only after they sort alphabetically — which means the
  // second one can lag arbitrarily long depending on dev sync timing.
  // We hit this once already (045 / 047 / 047). Fail loudly instead.
  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const m = /^(\d+)_/.exec(file);
    if (!m) continue;
    const list = byPrefix.get(m[1]!) ?? [];
    list.push(file);
    byPrefix.set(m[1]!, list);
  }
  const dupes = [...byPrefix.entries()].filter(([, list]) => list.length > 1);
  if (dupes.length > 0) {
    const detail = dupes
      .map(([n, list]) => `  ${n}: ${list.join(", ")}`)
      .join("\n");
    throw new Error(
      `[migrate] duplicate migration prefix(es). Renumber so each file has a unique prefix:\n${detail}`,
    );
  }

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
