import { ValidationError } from "@x1agent/kernel";
import type { AgentEnvBinding } from "../domain/binding.js";
import { EnvName } from "../domain/env-name.js";
import type { BindingRepository } from "../ports/binding-repository.js";

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/**
 * Verifies that a workspace secret exists. The agent-env domain owns
 * the binding shape but not the secret store — the API layer wires
 * a thin adapter to workspace-secrets here.
 */
export interface SecretExistsCheck {
  (workspaceId: string, secretName: string): Promise<boolean>;
}

export interface BindingSetInput {
  agentId: string;
  workspaceId: string;
  envName: string;
  secretName: string;
  createdBy: string | null;
}

export class BindingService {
  constructor(
    private readonly repo: BindingRepository,
    private readonly secretExists: SecretExistsCheck,
  ) {}

  list(agentId: string): Promise<AgentEnvBinding[]> {
    return this.repo.listByAgent(agentId);
  }

  hasAny(agentId: string): Promise<boolean> {
    return this.repo.agentHasAny(agentId);
  }

  async set(input: BindingSetInput): Promise<AgentEnvBinding> {
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
      agentId: input.agentId,
      envName,
      secretName,
      createdBy: input.createdBy,
    });
  }

  delete(agentId: string, rawEnvName: string): Promise<boolean> {
    const envName = EnvName(rawEnvName);
    return this.repo.delete(agentId, envName);
  }
}
