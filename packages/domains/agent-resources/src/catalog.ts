import type { SharedResourceKind } from "./domain/shared-resource.js";

/**
 * A single catalog entry describes what the platform can install.
 * `available` is set at composition time based on whether the engine's
 * adapter is actually wired in this deployment.
 *
 * v1: the catalog is code-embedded here. The shape matches what a
 * ConfigMap-driven v2 will deserialize into, so moving to an operator-
 * editable catalog is a drop-in replacement for the loadStaticCatalog()
 * default.
 */
export interface CatalogEntry {
  kind: SharedResourceKind;
  display_name: string;
  description: string;
  versions: readonly string[];
  default_version: string;
  default_storage_size: string;
  /** Override-filled per deployment; not part of the static catalog. */
  available?: boolean;
}

const STATIC_CATALOG: readonly CatalogEntry[] = [
  {
    kind: "postgres",
    display_name: "PostgreSQL",
    description:
      "Per-workspace Postgres with per-(repo, branch) databases cloned from main. Ideal for app state, migrations, and anything schema-based.",
    versions: ["16", "15"],
    default_version: "16",
    default_storage_size: "20Gi",
  },
  {
    kind: "redis",
    display_name: "Redis",
    description:
      "Per-workspace Redis with per-branch ACL users and key/channel prefix isolation. Ideal for caches, queues, and pub/sub.",
    versions: ["7"],
    default_version: "7",
    default_storage_size: "5Gi",
  },
];

/**
 * Returns the static, code-embedded catalog. The composition root
 * decorates each entry with `available` based on the wired installers.
 */
export function loadStaticCatalog(): readonly CatalogEntry[] {
  return STATIC_CATALOG;
}
