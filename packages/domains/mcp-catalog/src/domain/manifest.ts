import { ValidationError } from "@x1agent/kernel";

/**
 * MCP server manifest. Declares the env vars the MCP container expects
 * and the tool scopes its tools map to. Pasted at registration time
 * (v1) or fetched from `/mcp-manifest.json` inside the image (future).
 *
 * Example:
 *   {
 *     "env": {
 *       "LINEAR_API_KEY": { "kind": "secret", "label": "Linear API key", "required": true },
 *       "LINEAR_TEAM_ID": { "kind": "value",  "label": "Team ID",        "required": false }
 *     },
 *     "tool_scopes": {
 *       "create_issue": ["linear.write"],
 *       "search_issues": ["linear.read"]
 *     }
 *   }
 */

export type EnvKind = "secret" | "value";

export interface EnvDeclaration {
  kind: EnvKind;
  /** Human-readable label for the UI; falls back to the env-var name. */
  label?: string;
  /** Defaults to true. Required env without a value blocks attachment. */
  required?: boolean;
  /** Optional one-line help text shown beneath the field in the UI. */
  description?: string;
}

export interface Manifest {
  env: Record<string, EnvDeclaration>;
  /** tool name → array of permission scope strings. Empty array allowed. */
  tool_scopes: Record<string, string[]>;
}

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates a parsed manifest object. Throws ValidationError with a
 * field path on the first problem; we don't accumulate because the
 * UI shows one error at a time and operators fix-and-retry.
 */
export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("manifest", "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) {
    throw new ValidationError("manifest.env", "must be an object");
  }
  const env: Record<string, EnvDeclaration> = {};
  for (const [name, decl] of Object.entries(obj.env as Record<string, unknown>)) {
    if (!ENV_VAR_RE.test(name)) {
      throw new ValidationError(
        `manifest.env.${name}`,
        "env-var name must match ^[A-Z_][A-Z0-9_]{0,63}$",
      );
    }
    if (typeof decl !== "object" || decl === null || Array.isArray(decl)) {
      throw new ValidationError(`manifest.env.${name}`, "must be an object");
    }
    const d = decl as Record<string, unknown>;
    if (d.kind !== "secret" && d.kind !== "value") {
      throw new ValidationError(
        `manifest.env.${name}.kind`,
        "must be 'secret' or 'value'",
      );
    }
    env[name] = {
      kind: d.kind,
      label: typeof d.label === "string" ? d.label : undefined,
      required: typeof d.required === "boolean" ? d.required : true,
      description:
        typeof d.description === "string" ? d.description : undefined,
    };
  }

  if (
    typeof obj.tool_scopes !== "object" ||
    obj.tool_scopes === null ||
    Array.isArray(obj.tool_scopes)
  ) {
    throw new ValidationError("manifest.tool_scopes", "must be an object");
  }
  const tool_scopes: Record<string, string[]> = {};
  for (const [tool, scopes] of Object.entries(
    obj.tool_scopes as Record<string, unknown>,
  )) {
    if (!TOOL_NAME_RE.test(tool)) {
      throw new ValidationError(
        `manifest.tool_scopes.${tool}`,
        "tool name must match ^[a-zA-Z_][a-zA-Z0-9_]*$",
      );
    }
    if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string")) {
      throw new ValidationError(
        `manifest.tool_scopes.${tool}`,
        "must be an array of strings",
      );
    }
    tool_scopes[tool] = scopes as string[];
  }

  return { env, tool_scopes };
}
