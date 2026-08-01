import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sql } from "./db/client.js";

const TEST_USER = process.env.TEST_USER;
const DEFAULT_WORKSPACE_SLUG = "default";
const DEFAULT_WORKSPACE_NAME = "Default";

// Platform presets the catalog exposes. These rows are seeded idempotently;
// `built_ref` points at the registry where `mise run images:publish` pushes.
// Pod-spec resolves agents.image_id to this row's built_ref at session launch.
//
// IMAGE_REGISTRY env overrides the default for prod installs (chart sets it
// to the install's Artifact Registry). Default = in-cluster dev registry.
//
// Version choices at seed time:
//   - Python 3.13 — latest stable CPython minor (5-year security support)
//   - Node.js 22 — Active LTS ("Jod")
//   - Go 1.24 — latest stable
//   - Rust stable — rolling channel; rustup resolves at build time
const REGISTRY =
  process.env.IMAGE_REGISTRY ||
  "x1-registry.x1agent.svc.cluster.local:5000";
const PLATFORM_PRESETS = [
  {
    name: "runtime-codex",
    display_name: "Codex (OpenAI)",
    description:
      "OpenAI Codex CLI runtime with the x1agent event harness and MCP bridge.",
    built_ref: `${REGISTRY}/x1agent/runtime-codex:v1`,
    dockerfile_path: "packages/agent-codex/Dockerfile",
  },
  {
    name: "runtime-core",
    display_name: "Lightweight (no language toolchain)",
    description:
      "Ships Node 22, tsx, the agent SDK, gh CLI, git, and the non-root user at uid 1000. No additional language toolchains. Pick this for non-coding agents (orchestration, summarization, API-only tools) — smallest image, fastest cold start.",
    built_ref: `${REGISTRY}/x1agent/runtime-core:v1`,
    dockerfile_path: "runtime-core/Dockerfile",
  },
  {
    name: "preset-python",
    display_name: "Python 3.13",
    description:
      "runtime-core + Python 3.13 (via uv standalone distribution), build-essential, ripgrep, jq. Generic Python target — add your own dependencies with uv or pip.",
    built_ref: `${REGISTRY}/x1agent/preset-python:v1`,
    dockerfile_path: "python/Dockerfile",
  },
  {
    name: "preset-node",
    display_name: "Node.js 22 LTS",
    description:
      "runtime-core + TypeScript CLI + pnpm. Node 22 is the current Active LTS (Jod).",
    built_ref: `${REGISTRY}/x1agent/preset-node:v1`,
    dockerfile_path: "node/Dockerfile",
  },
  {
    name: "preset-go",
    display_name: "Go 1.24",
    description:
      "runtime-core + the Go 1.24 toolchain from the official go.dev tarball. GOPATH at /home/agent/go; `go install` targets land on PATH.",
    built_ref: `${REGISTRY}/x1agent/preset-go:v1`,
    dockerfile_path: "go/Dockerfile",
  },
  {
    name: "preset-rust",
    display_name: "Rust stable",
    description:
      "runtime-core + rustup stable toolchain (minimal profile) + clippy + rustfmt. Common native-link deps (build-essential, pkg-config, libssl-dev) pre-installed.",
    built_ref: `${REGISTRY}/x1agent/preset-rust:v1`,
    dockerfile_path: "rust/Dockerfile",
  },
] as const;

function readDockerfile(relativePath: string): string {
  // api runs from /app/packages/api; Dockerfiles live at
  // /app/deploy/images/<name>/Dockerfile (baked into the dev image).
  // Fall back to empty if the file isn't there — detail view will
  // render a placeholder note.
  try {
    const root = resolve(process.cwd(), "..", "..");
    const path = relativePath.startsWith("packages/")
      ? join(root, relativePath)
      : join(root, "deploy", "images", relativePath);
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Always-run seed: platform image presets that every install needs.
 * Idempotent. Splits out from the dev-only seed because the original
 * seedIfDev() bailed early on NODE_ENV=production, leaving prod
 * installs with an empty container registry.
 *
 * Caller is responsible for setting IMAGE_REGISTRY env so built_ref
 * points at the install's actual registry (Artifact Registry in prod,
 * x1-registry in OrbStack dev).
 */
export async function seedPlatformPresets() {
  for (const preset of PLATFORM_PRESETS) {
    const dockerfileSource = readDockerfile(preset.dockerfile_path);
    await sql`
      INSERT INTO agent_images
        (workspace_id, name, display_name, description, built_ref,
         is_preset, dockerfile_source, build_status)
      VALUES
        (NULL, ${preset.name}, ${preset.display_name},
         ${preset.description}, ${preset.built_ref}, true,
         ${dockerfileSource}, 'ready')
      ON CONFLICT (name) WHERE workspace_id IS NULL
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        built_ref = EXCLUDED.built_ref,
        dockerfile_source = EXCLUDED.dockerfile_source,
        build_status = 'ready',
        updated_at = now()
    `;
  }
  // Drop preset rows that were removed from this list. Any agent
  // referencing a dropped preset gets image_id → NULL via the
  // ON DELETE SET NULL on agents.image_id; pod-spec falls back to
  // the deployment-wide AGENT_IMAGE.
  const liveNames = PLATFORM_PRESETS.map((p) => p.name);
  await sql`
    DELETE FROM agent_images
    WHERE workspace_id IS NULL
      AND is_preset = true
      AND name <> ALL(${liveNames as unknown as string[]})
  `;
  console.log(`[seed] platform presets ready: ${PLATFORM_PRESETS.length}`);
}

/**
 * Dev-only seed: default workspace + test user. Runs in addition to
 * seedPlatformPresets when NODE_ENV !== production.
 */
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
