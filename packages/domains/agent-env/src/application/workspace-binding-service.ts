import { ValidationError } from "@x1agent/kernel";
import type { WorkspaceEnvBinding } from "../domain/workspace-binding.js";
import { EnvName } from "../domain/env-name.js";
import type { WorkspaceBindingRepository } from "../ports/workspace-binding-repository.js";
import type { SecretExistsCheck } from "./binding-service.js";

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export interface WorkspaceBindingSetInput {
  workspaceId: string;
  envName: string;
  secretName: string;
  createdBy: string | null;
}

/**
 * Workspace-scoped twin of BindingService. Same validation rules, same
 * "verify the workspace secret exists" gate, different owner. Used by
 * the workspace-admin env-bindings UI and by the preview-deploy
 * resolver that turns a preview env's selected names into secret values.
 */
export class WorkspaceBindingService {
  constructor(
    private readonly repo: WorkspaceBindingRepository,
    private readonly secretExists: SecretExistsCheck,
  ) {}

  list(workspaceId: string): Promise<WorkspaceEnvBinding[]> {
    return this.repo.listByWorkspace(workspaceId);
  }

  findByNames(
    workspaceId: string,
    envNames: readonly string[],
  ): Promise<WorkspaceEnvBinding[]> {
    return this.repo.findByNames(workspaceId, envNames);
  }

  async set(input: WorkspaceBindingSetInput): Promise<WorkspaceEnvBinding> {
    const envName = EnvName(input.envName);
    const secretName = input.secretName.trim();
    if (!SECRET_NAME_RE.test(secretName)) {
      throw new ValidationError(
        "secret_name",
        "must be uppercase letters, digits, underscores; 1–64 chars; start with a letter or underscore",
      );
    }
    const exists = await this.secretExists(input.workspaceId, secretName);
    if (!exists) {
      throw new ValidationError(
        "secret_name",
        `workspace secret '${secretName}' does not exist`,
      );
    }
    return this.repo.upsert({
      workspaceId: input.workspaceId,
      envName,
      secretName,
      createdBy: input.createdBy,
    });
  }

  delete(workspaceId: string, rawEnvName: string): Promise<boolean> {
    const envName = EnvName(rawEnvName);
    return this.repo.delete(workspaceId, envName);
  }
}
