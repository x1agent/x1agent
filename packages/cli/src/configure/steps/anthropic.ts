import { isCancel, note, password, select, text } from "@clack/prompts";

export type AnthropicProvider = "api_key" | "vertex";

export interface AnthropicCredentials {
  provider: AnthropicProvider;
  /** Set when provider === "api_key". */
  apiKey?: string;
  /**
   * Set when provider === "vertex". Region must be one of the regions
   * Anthropic supports on Vertex (us-east5 is the canonical one for v4
   * models; europe-west1 + us-central1 for older Sonnet variants).
   */
  vertexRegion?: string;
  /**
   * GCP project ID hosting the Vertex AI Anthropic models. Almost always
   * the same as GCP_PROJECT_ID, but kept separate so an operator can
   * route Vertex through a different project (e.g. shared model project,
   * billing isolation).
   */
  vertexProjectId?: string;
}

const VERTEX_REGION_DEFAULT = "us-east5";

export async function promptAnthropic(
  current: Partial<AnthropicCredentials>,
  cloudProvider: "local" | "gcp",
  defaultGcpProjectId?: string,
): Promise<AnthropicCredentials | null> {
  // Vertex is GCP-only. For local installs, only the API-key path makes
  // sense (no Workload Identity inside OrbStack).
  let provider: AnthropicProvider;
  if (cloudProvider !== "gcp") {
    provider = "api_key";
    note(
      "Local target — using direct Anthropic API. Vertex is only available\n" +
        "on GCP installs.",
      "Anthropic credentials",
    );
  } else {
    const choice = await select<AnthropicProvider>({
      message: "Anthropic credential source",
      options: [
        {
          value: "vertex",
          label: "Vertex AI (recommended for GCP installs)",
          hint: "Workload Identity, no key file, GCP-side quota + billing",
        },
        {
          value: "api_key",
          label: "Direct Anthropic API",
          hint: "ANTHROPIC_API_KEY — rate-limited per Anthropic account tier",
        },
      ],
      initialValue: current.provider ?? "vertex",
    });
    if (isCancel(choice)) return null;
    provider = choice;
  }

  if (provider === "api_key") {
    const key = await password({
      message: "Anthropic API key (sk-ant-...)",
      mask: "•",
      validate: (raw) => {
        const t = raw.trim();
        if (!t && current.apiKey) return undefined; // keep current
        if (!t) return "Required. Get one at https://console.anthropic.com";
        if (!t.startsWith("sk-ant-"))
          return "Anthropic API keys start with 'sk-ant-'.";
        return undefined;
      },
    });
    if (isCancel(key)) return null;
    const t = (key as string).trim();
    return {
      provider: "api_key",
      apiKey: t || current.apiKey || "",
    };
  }

  // ── Vertex path ──────────────────────────────────────────────────
  note(
    "Claude on Vertex requires one manual step BEFORE this install can\n" +
      "actually call the model:\n\n" +
      "  GCP Console → Vertex AI → Model Garden → search 'Claude' →\n" +
      "  Request access for each Anthropic model you'll use.\n\n" +
      "Approval is typically minutes-to-hours. Fire it now if you haven't.\n" +
      "Without it, the agent runtime returns 403 on the first turn.",
    "Heads up",
  );

  const region = await text({
    message: "Vertex region",
    placeholder: VERTEX_REGION_DEFAULT,
    initialValue: current.vertexRegion || VERTEX_REGION_DEFAULT,
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required.";
      if (!/^[a-z]+-[a-z]+\d+$/.test(t))
        return "Looks like an invalid GCP region (e.g. us-east5).";
      return undefined;
    },
  });
  if (isCancel(region)) return null;

  const projectId = await text({
    message: "GCP project hosting Vertex (default: same as cluster project)",
    placeholder: defaultGcpProjectId ?? "x1agent",
    initialValue: current.vertexProjectId || defaultGcpProjectId || "",
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required.";
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(t))
        return "GCP project IDs are 6-30 chars, lowercase alphanumeric + hyphens.";
      return undefined;
    },
  });
  if (isCancel(projectId)) return null;

  return {
    provider: "vertex",
    vertexRegion: (region as string).trim(),
    vertexProjectId: (projectId as string).trim(),
  };
}
