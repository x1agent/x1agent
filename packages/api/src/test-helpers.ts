import postgres from "postgres";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "..", "deploy", "migrations");

const adminUrl =
  process.env.DATABASE_URL ||
  "postgres://x1agent:x1agent@localhost:5432/x1agent";

function dbUrlFor(name: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Drop and recreate a named test database, then apply all migrations.
 * Returns a postgres client connected to it.
 */
export async function freshTestDb(name: string) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();

  const testSql = postgres(dbUrlFor(name), { max: 2, onnotice: () => {} });
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = await readFile(join(migrationsDir, file), "utf8");
    await testSql.unsafe(content);
  }
  return { sql: testSql, url: dbUrlFor(name) };
}

export async function dropTestDb(name: string) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}
