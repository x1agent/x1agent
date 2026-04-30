/**
 * Capability descriptor — what backend providers are installed for this
 * deployment. The frontend reads this on boot and gates UI surfaces
 * (nav entries, CTAs, permission-grant pickers) on it. A workspace
 * without a graph provider does not show a Collections tab.
 *
 * Each domain key maps to either:
 *   - false / null → no provider installed; UI must hide the surface
 *   - a non-empty string → provider id (e.g. "surrealdb"); UI shows it
 *
 * Wire format is intentionally flat + boolean-ish so the frontend can
 * just check `caps.graph` truthiness without parsing.
 */
export interface Capabilities {
  graph: string | null;
  vector: string | null;
  messaging: string[];
}

/** Read provider env vars and produce a Capabilities snapshot. */
export function readCapabilitiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Capabilities {
  return {
    graph: nullable(env.PROVIDER_GRAPH),
    vector: nullable(env.PROVIDER_VECTOR),
    messaging: list(env.PROVIDER_MESSAGING),
  };
}

function nullable(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "none" || v === "off" || v === "disabled") return null;
  return v;
}

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && s !== "none");
}
