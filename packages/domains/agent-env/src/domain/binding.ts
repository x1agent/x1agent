import type { EnvName } from "./env-name.js";

/**
 * One Zone-2 env-var binding for an agent. The agent container will
 * see process.env[envName] populated from the workspace secret at
 * `secretName` at session-launch time.
 */
export interface AgentEnvBinding {
  id: string;
  agentId: string;
  envName: EnvName;
  /** Workspace secret name. The bare reference, NOT `${...}`-wrapped. */
  secretName: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
