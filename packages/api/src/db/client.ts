import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

let client: Sql | null = null;

export function getSql(): Sql {
  if (!client) {
    const url =
      process.env.DATABASE_URL ||
      "postgres://x1agent:x1agent@localhost:5432/x1agent";
    client = postgres(url, { onnotice: () => {} });
  }
  return client;
}

export async function resetSql(): Promise<void> {
  if (client) {
    await client.end({ timeout: 1 });
    client = null;
  }
}

/**
 * Proxy that lazily resolves `sql` on each call site.
 * Lets test code change DATABASE_URL before the first real query
 * without losing the familiar `await sql\`...\`` ergonomics.
 */
export const sql = new Proxy((() => {}) as unknown as Sql, {
  get(_t, prop) {
    return Reflect.get(getSql() as unknown as object, prop);
  },
  apply(_t, thisArg, args) {
    return Reflect.apply(
      getSql() as unknown as (...a: unknown[]) => unknown,
      thisArg,
      args,
    );
  },
}) as Sql;
