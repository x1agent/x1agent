import type { WorkspaceEnvBinding } from "../domain/workspace-binding.js";
import type { EnvName } from "../domain/env-name.js";

export interface WorkspaceBindingUpsertInput {
  workspaceId: string;
  envName: EnvName;
  secretName: string;
  createdBy: string | null;
}

export interface WorkspaceBindingRepository {
  listByWorkspace(workspaceId: string): Promise<WorkspaceEnvBinding[]>;
  upsert(input: WorkspaceBindingUpsertInput): Promise<WorkspaceEnvBinding>;
  delete(workspaceId: string, envName: EnvName): Promise<boolean>;

  /**
   * Bulk lookup for the preview-deploy resolver: given a workspace and
   * a list of env names the preview wants, return matching bindings.
   * Names not bound at the workspace are silently dropped — the caller
   * decides whether that's a hard error or a soft miss.
   */
  findByNames(
    workspaceId: string,
    envNames: readonly string[],
  ): Promise<WorkspaceEnvBinding[]>;
}
