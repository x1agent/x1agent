import type { AgentEnvBinding } from "../domain/binding.js";
import type { EnvName } from "../domain/env-name.js";

export interface BindingUpsertInput {
  agentId: string;
  envName: EnvName;
  secretName: string;
  createdBy: string | null;
}

export interface BindingRepository {
  listByAgent(agentId: string): Promise<AgentEnvBinding[]>;
  upsert(input: BindingUpsertInput): Promise<AgentEnvBinding>;
  delete(agentId: string, envName: EnvName): Promise<boolean>;

  /** Used to compute the "operator-injected credentials" badge. */
  agentHasAny(agentId: string): Promise<boolean>;
}
