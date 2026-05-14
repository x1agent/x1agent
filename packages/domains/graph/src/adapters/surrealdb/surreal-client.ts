import {
  GraphProviderUnreachableError,
  GraphUnauthorizedError,
} from "../../domain/errors.js";
import { assertSingleStatement } from "./surreal-query-guard.js";

export interface SurrealClientConfig {
  /** e.g. http://surrealdb:8000 */
  url: string;
  /** Root username. */
  username: string;
  /** Root password. */
  password: string;
  /**
   * Bootstrap SurrealDB namespace. Pre-Layer-2 this was the install-
   * wide namespace every collection landed in. Post-Layer-2 it is
   * only used as the active namespace for DEFINE NAMESPACE bootstrap
   * calls when no caller-supplied namespace is available — the
   * provider service migrates collections into per-workspace
   * namespaces (`ws_<slug>`) on provision and pins the namespace per
   * request from then on.
   */
  namespace: string;
}

/**
 * Thin HTTP wrapper around SurrealDB's `/sql` endpoint. Translates
 * transport + auth failures into domain errors so callers (the
 * adapter) can re-throw without knowing about reqwest / fetch
 * plumbing.
 *
 * Used by both SurrealGraphProvider and SurrealVectorProvider — one
 * db per collection within a per-workspace namespace, same HTTP
 * surface, different queries.
 */
export class SurrealClient {
  constructor(readonly cfg: SurrealClientConfig) {}

  private authHeader(): string {
    const encoded =
      typeof Buffer !== "undefined"
        ? Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString(
            "base64",
          )
        : globalThis.btoa(`${this.cfg.username}:${this.cfg.password}`);
    return `Basic ${encoded}`;
  }

  /**
   * Forwards a SurrealQL body to SurrealDB's `/sql` endpoint.
   *
   * `ns` pins `surreal-ns` per request; defaults to `cfg.namespace`
   * (the install bootstrap namespace) so legacy callers that haven't
   * been migrated to per-workspace namespaces still work for now.
   * Callers that operate on a specific workspace's data MUST pass
   * the workspace namespace explicitly — the SurrealClient does not
   * resolve it from the database name.
   *
   * `opts.allowMultiStatement` is a Layer 3 defense (see t03 P0 #2):
   * any path that takes agent-controlled input MUST leave this at
   * `false` (the default) so a body containing multiple statements is
   * refused before it reaches the database. Only `provision` and
   * `deprovision` legitimately send multi-statement DDL bundles; they
   * pass `{ allowMultiStatement: true }`.
   */
  async sql(
    query: string,
    db: string | null = null,
    opts: { allowMultiStatement?: boolean; ns?: string | null } = {},
  ): Promise<unknown> {
    if (!opts.allowMultiStatement) assertSingleStatement(query);
    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
      Accept: "application/json",
      Authorization: this.authHeader(),
      "surreal-ns": opts.ns ?? this.cfg.namespace,
    };
    if (db) headers["surreal-db"] = db;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.url.replace(/\/$/, "")}/sql`, {
        method: "POST",
        headers,
        body: query,
      });
    } catch (err) {
      throw new GraphProviderUnreachableError(
        "surrealdb",
        (err as Error)?.message ?? String(err),
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new GraphUnauthorizedError("surrealdb", await res.text());
    }
    if (!res.ok) {
      throw new GraphProviderUnreachableError(
        "surrealdb",
        `HTTP ${res.status}: ${await res.text()}`,
      );
    }
    return res.json();
  }
}
