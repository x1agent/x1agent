import { sql } from "./db/client.js";

const TEST_USER = process.env.TEST_USER;
const DEFAULT_WORKSPACE_SLUG = "default";
const DEFAULT_WORKSPACE_NAME = "Default";

export async function seedIfDev() {
  if (process.env.NODE_ENV === "production") return;

  const [ws] = await sql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name)
    VALUES (${DEFAULT_WORKSPACE_SLUG}, ${DEFAULT_WORKSPACE_NAME})
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  if (!ws) return;
  console.log(`[seed] workspace ready: ${DEFAULT_WORKSPACE_SLUG}`);

  if (TEST_USER) {
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name)
      VALUES (${TEST_USER}, ${TEST_USER})
      ON CONFLICT (email) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    if (user) {
      await sql`
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES (${ws.id}, ${user.id}, 'owner')
        ON CONFLICT (workspace_id, user_id) DO NOTHING
      `;
      console.log(`[seed] test user added to workspace`);
    }
  }
}
