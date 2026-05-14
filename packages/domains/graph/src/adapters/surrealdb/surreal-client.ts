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
   * SurrealDB namespace that holds every collection database. One per
   * platform install — we keep x1agent collections in a single ns so
   * operator-level queries scan the whole fleet at once.
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
 * db per collection, same HTTP surface, different queries.
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
    opts: { allowMultiStatement?: boolean } = {},
  ): Promise<unknown> {
    if (!opts.allowMultiStatement) assertSingleStatement(query);
    const headers: Record<string, string> = {
      "Content-Type": "text/plain",
      Accept: "application/json",
      Authorization: this.authHeader(),
      "surreal-ns": this.cfg.namespace,
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
