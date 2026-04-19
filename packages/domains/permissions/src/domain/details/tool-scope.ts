import { InvalidGrantShapeError } from "../grant.js";
import { registerGrantType, type DetailsValidator } from "./registry.js";

export const TOOL_SCOPE_GRANT_TYPE = "tool_scope";

export interface ToolScopeDetails extends Record<string, unknown> {
  scope: string;
}

/** `domain.action`, e.g. `git.write`, `gmail.read`, `calendar.write`. */
const TOOL_SCOPE_RE = /^[a-z]+(\.[a-z]+)+$/;

export const validateToolScopeDetails: DetailsValidator<ToolScopeDetails> = (
  raw,
) => {
  if (typeof raw !== "object" || raw === null)
    throw new InvalidGrantShapeError(
      `${TOOL_SCOPE_GRANT_TYPE} details must be an object`,
    );
  const r = raw as Record<string, unknown>;
  const scope = r["scope"];
  if (typeof scope !== "string")
    throw new InvalidGrantShapeError(
      `${TOOL_SCOPE_GRANT_TYPE} details.scope must be a string`,
    );
  if (!TOOL_SCOPE_RE.test(scope))
    throw new InvalidGrantShapeError(
      `${TOOL_SCOPE_GRANT_TYPE} details.scope must look like domain.action`,
    );
  const extra = Object.keys(r).filter((k) => k !== "scope");
  if (extra.length > 0)
    throw new InvalidGrantShapeError(
      `${TOOL_SCOPE_GRANT_TYPE} details has unknown fields: ${extra.join(", ")}`,
    );
  return { scope };
};

registerGrantType(TOOL_SCOPE_GRANT_TYPE, validateToolScopeDetails);
