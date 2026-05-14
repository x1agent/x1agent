import { ValidationError } from "@x1agent/kernel";

/**
 * SurrealDB namespace that owns a single workspace's collections.
 * Format: `ws_<workspace_slug>` with kebab-case slugs lowered to
 * snake-case (SurrealDB identifiers don't accept `-`). Pairs with
 * `CollectionHandle` (the per-collection database name) to fully
 * address a backing store; together they let an agent in workspace A
 * never reach workspace B's data even if SurrealQL's namespace-scope
 * directives were to escape the input guard. See t03 P0 #2.
 */
declare const workspaceNamespaceBrand: unique symbol;
export type WorkspaceNamespace = string & {
  readonly [workspaceNamespaceBrand]: true;
};

const NS_RE = /^ws_[a-z][a-z0-9_]{0,60}$/;

export const WorkspaceNamespace = (raw: string): WorkspaceNamespace => {
  if (!NS_RE.test(raw))
    throw new ValidationError(
      "workspace_namespace",
      "namespace must match ws_<lowercase-alphanumeric-underscore>, 4-63 chars",
    );
  return raw as WorkspaceNamespace;
};

/**
 * Builds the canonical workspace namespace identifier from a
 * workspace slug. Kept as a function (not inlined) so every site —
 * the api when serializing into pod env, the postgres backfill, the
 * provider when validating an incoming NATS body — derives the same
 * string from the same input.
 */
export function workspaceNamespaceFromSlug(slug: string): WorkspaceNamespace {
  return WorkspaceNamespace(`ws_${slug.replace(/-/g, "_")}`);
}
