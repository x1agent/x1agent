import { sql } from "./db/client.js";

const TEST_USER = process.env.TEST_USER;
const DEFAULT_WORKSPACE_SLUG = "default";
const DEFAULT_WORKSPACE_NAME = "Default";

// Platform presets the catalog exposes. These rows are seeded idempotently;
// `built_ref` points at the in-cluster registry path that `mise run
// images:publish` pushes to. Pod-spec resolves agents.image_id to this
// row's built_ref at session launch.
const PLATFORM_PRESETS = [
  {
    name: "runtime-core",
    display_name: "x1 runtime core",
    description:
      "Base image every preset FROMs. Ships the agent SDK, gh CLI, git, and the non-root user at uid 1000. No language toolchains.",
    built_ref: "x1-registry.x1agent.svc.cluster.local:5000/x1agent/runtime-core:v1",
  },
  {
    name: "preset-python-django",
    display_name: "Python / Django",
    description:
      "runtime-core + Python 3.12, libpq-dev, postgresql-client, ripgrep, jq, uv. Suitable for Django and FastAPI projects.",
    built_ref:
      "x1-registry.x1agent.svc.cluster.local:5000/x1agent/preset-python-django:v1",
  },
] as const;

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

  for (const preset of PLATFORM_PRESETS) {
    await sql`
      INSERT INTO agent_images (workspace_id, name, display_name, description, built_ref, is_preset)
      VALUES (NULL, ${preset.name}, ${preset.display_name}, ${preset.description},
              ${preset.built_ref}, true)
      ON CONFLICT (name) WHERE workspace_id IS NULL
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        built_ref = EXCLUDED.built_ref,
        updated_at = now()
    `;
  }
  console.log(`[seed] platform presets ready: ${PLATFORM_PRESETS.length}`);
}
