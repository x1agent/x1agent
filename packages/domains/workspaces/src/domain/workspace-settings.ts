/**
 * Per-workspace policy toggles.
 *
 * Stored as JSONB on the `workspaces` row; this module is the single
 * place that decodes/encodes them so the application layer never
 * sees a raw `Record<string, unknown>`. Defaults applied here flow
 * through to every reader — older rows without the JSON key still
 * read as the safe value.
 *
 * Adding a new setting:
 *   1. Add a typed field below.
 *   2. Add its safe default in `WORKSPACE_SETTINGS_DEFAULTS`.
 *   3. Decode it in `parseWorkspaceSettings`.
 *   4. Whitelist it in `parseWorkspaceSettingsPatch`.
 *
 * Default for every new setting must be the conservative / restrictive
 * value so workspaces inherit safe behavior without explicit opt-in.
 */
export const OAUTH_MCPS_ON_ORCHESTRATORS_VALUES = [
  /** Block attaching remote_oauth MCPs to orchestrator agents. Safe default. */
  "off",
  /**
   * Allow attaching remote_oauth MCPs to orchestrator agents. The
   * runtime injects the triggering user's token only for sessions
   * with a driving user (manual UI triggers). Cron-spawned and
   * parent-spawned (unattended) runs return `permission_required`
   * cleanly on the first OAuth tool call.
   */
  "on_attended",
  /**
   * Allow attaching AND attempt to inject tokens even for unattended
   * sessions, falling back to a workspace-designated user's tokens.
   * Reserved — the "always-inject" runtime path is not yet wired, so
   * today this behaves identically to `on_attended`. Choosing this
   * value tells the platform "I want this once the fallback is
   * implemented" without forcing a re-config later.
   */
  "on",
] as const;
export type OauthMcpsOnOrchestratorsMode =
  (typeof OAUTH_MCPS_ON_ORCHESTRATORS_VALUES)[number];

const OAUTH_MCPS_ON_ORCHESTRATORS_SET: ReadonlySet<string> = new Set(
  OAUTH_MCPS_ON_ORCHESTRATORS_VALUES,
);

export interface WorkspaceSettings {
  /**
   * Whether `remote_oauth` MCPs may be attached to orchestrator (and
   * scheduled) agents, and how the runtime should treat unattended
   * runs that hit them. See `OAUTH_MCPS_ON_ORCHESTRATORS_VALUES`.
   */
  oauthMcpsOnOrchestrators: OauthMcpsOnOrchestratorsMode;
  /** Allow this workspace to appear through the public administrative MCP. */
  adminMcpEnabled: boolean;
}

export const WORKSPACE_SETTINGS_DEFAULTS: Readonly<WorkspaceSettings> = {
  oauthMcpsOnOrchestrators: "off",
  adminMcpEnabled: false,
};

/**
 * Decode a raw JSON value (as it comes off the JSONB column) into a
 * fully-populated `WorkspaceSettings`. Unknown keys are ignored.
 * Wrong-typed or unknown-string values fall back to the default.
 */
export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const mode = obj.oauthMcpsOnOrchestrators;
  return {
    oauthMcpsOnOrchestrators:
      typeof mode === "string" && OAUTH_MCPS_ON_ORCHESTRATORS_SET.has(mode)
        ? (mode as OauthMcpsOnOrchestratorsMode)
        : WORKSPACE_SETTINGS_DEFAULTS.oauthMcpsOnOrchestrators,
    adminMcpEnabled:
      typeof obj.adminMcpEnabled === "boolean"
        ? obj.adminMcpEnabled
        : WORKSPACE_SETTINGS_DEFAULTS.adminMcpEnabled,
  };
}

/**
 * Validate + narrow a partial settings patch coming off the API.
 * Strips unknown keys and rejects wrong-typed values. Caller merges
 * the result onto the current settings before persisting.
 */
export function parseWorkspaceSettingsPatch(
  raw: unknown,
): Partial<WorkspaceSettings> {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: Partial<WorkspaceSettings> = {};
  if (
    "oauthMcpsOnOrchestrators" in obj &&
    typeof obj.oauthMcpsOnOrchestrators === "string" &&
    OAUTH_MCPS_ON_ORCHESTRATORS_SET.has(obj.oauthMcpsOnOrchestrators)
  ) {
    out.oauthMcpsOnOrchestrators =
      obj.oauthMcpsOnOrchestrators as OauthMcpsOnOrchestratorsMode;
  }
  if ("adminMcpEnabled" in obj && typeof obj.adminMcpEnabled === "boolean") {
    out.adminMcpEnabled = obj.adminMcpEnabled;
  }
  return out;
}

/**
 * Convenience predicate used by the attachment use case: returns true
 * when the workspace's policy allows attaching remote_oauth MCPs to
 * non-worker agents at all. Both `on_attended` and `on` allow it; only
 * `off` blocks. (The `on_attended` vs `on` distinction lives at runtime,
 * not at attach time.)
 */
export function workspacePermitsOauthOnNonWorkers(
  settings: WorkspaceSettings,
): boolean {
  return settings.oauthMcpsOnOrchestrators !== "off";
}
