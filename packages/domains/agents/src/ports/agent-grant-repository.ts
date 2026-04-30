import type { Subject, UserId } from "@x1agent/kernel";
import type { AgentId } from "../domain/agent.js";
import type {
  AgentGrant,
  AgentGrantId,
  AgentVerb,
} from "../domain/grant.js";

export interface CreateAgentGrantInput {
  agentId: AgentId;
  subject: Subject;
  verb: AgentVerb;
  grantedBy: UserId;
}

export interface AgentGrantRepository {
  /**
   * Idempotent on (agent, subject, verb). Re-granting bumps shared_by
   * + created_at without creating a duplicate row.
   */
  upsert(input: CreateAgentGrantInput): Promise<AgentGrant>;
  remove(id: AgentGrantId): Promise<void>;
  removeForSubject(
    agentId: AgentId,
    subject: Subject,
    verb: AgentVerb,
  ): Promise<void>;
  listForAgent(agentId: AgentId): Promise<readonly AgentGrant[]>;
  /**
   * For "what verbs does this user have on this agent?" — checks
   * direct user grants + group-membership grants + workspace/public
   * grants. The repo doesn't know about workspace membership; the
   * caller pre-resolves which groups the user is in and passes them.
   */
  listVerbsForResolver(input: {
    agentId: AgentId;
    userId: UserId;
    userGroupIds: readonly string[];
    userIsWorkspaceMember: boolean;
  }): Promise<ReadonlySet<AgentVerb>>;
}
