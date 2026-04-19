import { AgentId } from "@x1agent/domain-agents";
import { InvalidGrantShapeError } from "../grant.js";
import { registerGrantType, type DetailsValidator } from "./registry.js";

export const SPAWN_GRANT_TYPE = "spawn";

export interface SpawnDetails extends Record<string, unknown> {
  child_agent_id: AgentId;
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
  const extra = Object.keys(r).filter((k) => k !== "child_agent_id");
  if (extra.length > 0)
    throw new InvalidGrantShapeError(
      `${SPAWN_GRANT_TYPE} details has unknown fields: ${extra.join(", ")}`,
    );
  return { child_agent_id: AgentId(id) };
};

registerGrantType(SPAWN_GRANT_TYPE, validateSpawnDetails);
