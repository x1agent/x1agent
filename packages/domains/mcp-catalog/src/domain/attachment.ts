/**
 * An agent's attachment to a workspace catalog entry. The user-supplied
 * env values land in env_json, where each value is one of:
 *   { kind: "value",  value: string }   — literal, lands in MCP env directly
 *   { kind: "secret", ref: string }     — workspace secret name, materialized
 *                                         at session-launch via secretKeyRef
 *
 * The secret name is the workspace_secrets.name value (NOT the bare
 * `${REF}` syntax — the wrapping is template syntax for *consumers*,
 * but we store the unwrapped name so resolution doesn't have to parse).
 */

export type AttachmentEnvValue =
  | { kind: "value"; value: string }
  | { kind: "secret"; ref: string };

export interface Attachment {
  id: string;
  agentId: string;
  catalogEntryId: string;
  envJson: Record<string, AttachmentEnvValue>;
  toolScopesGranted: string[];
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}
