import { ValidationError } from "@x1agent/kernel";

/**
 * Provider-opaque identifier for the store a vector lives in. For a
 * SurrealDB-backed collection this equals the `CollectionHandle` from
 * @x1agent/domain-graph — same database, different retrieval lens. A
 * Turbopuffer-backed setup would translate this to a namespace id. The
 * domain keeps both names so vector can be split off without rippling.
 */
declare const vectorNamespaceBrand: unique symbol;
export type VectorNamespace = string & {
  readonly [vectorNamespaceBrand]: true;
};

const RE = /^[a-z][a-z0-9_]{0,62}$/;

export const VectorNamespace = (raw: string): VectorNamespace => {
  if (!RE.test(raw))
    throw new ValidationError(
      "vector_namespace",
      "namespace must be lowercase alphanumeric + underscore, 1-63 chars, start with a letter",
    );
  return raw as VectorNamespace;
};
