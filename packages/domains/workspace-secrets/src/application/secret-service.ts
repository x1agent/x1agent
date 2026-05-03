import type { SecretMetadata } from "../domain/secret.js";
import { SecretName } from "../domain/secret-name.js";
import type { SecretRepository } from "../ports/secret-repository.js";
import { type MasterKey, encrypt, decrypt } from "./cipher.js";

/**
 * Use-case orchestrator. Composes the cipher + repository so the
 * Hono routes (or any other entry surface) can deal in plain inputs
 * and never see the master key directly.
 */
export class SecretService {
  constructor(
    private readonly repo: SecretRepository,
    private readonly key: MasterKey,
  ) {}

  list(workspaceId: string): Promise<SecretMetadata[]> {
    return this.repo.list(workspaceId);
  }

  /**
   * Set or rotate a secret. Idempotent. Plaintext is encrypted before
   * the repository sees it; the plaintext string is never logged or
   * returned.
   */
  async set(
    workspaceId: string,
    rawName: string,
    plaintext: string,
    updatedBy: string | null,
  ): Promise<SecretMetadata> {
    const name = SecretName(rawName);
    if (plaintext === "") {
      // An empty value is almost certainly a UI mistake (e.g. user
      // hit save without typing). Reject loudly rather than store
      // an encrypted empty string that confuses downstream consumers.
      const err: Error & { field?: string; status?: number } = new Error(
        "value cannot be empty",
      );
      err.field = "value";
      err.status = 400;
      throw err;
    }
    const blob = encrypt(plaintext, this.key);
    return this.repo.upsert(workspaceId, name, blob, updatedBy);
  }

  delete(workspaceId: string, rawName: string): Promise<boolean> {
    const name = SecretName(rawName);
    return this.repo.delete(workspaceId, name);
  }

  /**
   * Decrypt and return a secret's plaintext. Used by trusted callers
   * inside the api process at session-launch to materialize Zone-2
   * agent-env bindings and (future) Zone-1 MCP container env. The
   * returned string MUST NOT cross a process boundary unencrypted —
   * write it into a K8s Secret stringData and reference by name from
   * the pod spec.
   *
   * Returns null when no such secret exists in the workspace.
   */
  async resolve(
    workspaceId: string,
    rawName: string,
  ): Promise<string | null> {
    const name = SecretName(rawName);
    const blob = await this.repo.getBlob(workspaceId, name);
    if (!blob) return null;
    return decrypt(blob, this.key);
  }
}
