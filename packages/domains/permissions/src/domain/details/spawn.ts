import { AgentId } from "@x1agent/domain-agents";
import { RUNTIME_TYPES, type RuntimeType } from "@x1agent/shared";
import { InvalidGrantShapeError } from "../grant.js";
import { registerGrantType, type DetailsValidator } from "./registry.js";

export const SPAWN_GRANT_TYPE = "spawn";

export interface SpawnDetails extends Record<string, unknown> {
  child_agent_id: AgentId;
  /** Optional allowlist of runtimes this delegation may request. */
  allowed_runtime_types?: RuntimeType[];
  /** Optional model-id allowlist for the delegated child. */
  allowed_models?: string[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const validateSpawnDetails: DetailsValidator<SpawnDetails> = (raw) => {
  if (typeof raw !== "object" || raw === null)
    throw new InvalidGrantShapeError(`${SPAWN_GRANT_TYPE} details must be an object`);
  const r = raw as Record<string, unknown>;
  const id = r["child_agent_id"];
  if (typeof id !== "string")
    throw new InvalidGrantShapeError(
      `${SPAWN_GRANT_TYPE} details.child_agent_id must be a string`,
    );
  if (!UUID_RE.test(id))
    throw new InvalidGrantShapeError(
      `${SPAWN_GRANT_TYPE} details.child_agent_id must be a uuid`,
    );
  const allowedRuntimeTypes = r["allowed_runtime_types"];
  if (allowedRuntimeTypes !== undefined) {
    if (
      !Array.isArray(allowedRuntimeTypes) ||
      allowedRuntimeTypes.some(
        (v) => typeof v !== "string" || !(RUNTIME_TYPES as readonly string[]).includes(v),
      )
    )
      throw new InvalidGrantShapeError(
        `${SPAWN_GRANT_TYPE} details.allowed_runtime_types must contain only supported runtimes`,
      );
  }
  const allowedModels = r["allowed_models"];
  if (
    allowedModels !== undefined &&
    (!Array.isArray(allowedModels) || allowedModels.some((v) => typeof v !== "string" || v.trim() === ""))
  )
    throw new InvalidGrantShapeError(
      `${SPAWN_GRANT_TYPE} details.allowed_models must be a list of non-empty model ids`,
    );
  const extra = Object.keys(r).filter(
    (k) => !["child_agent_id", "allowed_runtime_types", "allowed_models"].includes(k),
  );
  if (extra.length > 0)
    throw new InvalidGrantShapeError(
      `${SPAWN_GRANT_TYPE} details has unknown fields: ${extra.join(", ")}`,
    );
  return {
    child_agent_id: AgentId(id),
    ...(allowedRuntimeTypes !== undefined
      ? { allowed_runtime_types: allowedRuntimeTypes as RuntimeType[] }
      : {}),
    ...(allowedModels !== undefined
      ? { allowed_models: (allowedModels as string[]).map((v) => v.trim()) }
      : {}),
  };
};

registerGrantType(SPAWN_GRANT_TYPE, validateSpawnDetails);
