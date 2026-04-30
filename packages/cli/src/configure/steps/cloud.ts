import { isCancel, note, select, text } from "@clack/prompts";

export type CloudProvider = "local" | "gcp";

export interface CloudTarget {
  provider: CloudProvider;
  /**
   * The host suffix under which the platform URLs live. app.<domain>,
   * api.<domain>, *.preview.<domain> are derived from this.
   *
   * For local OrbStack dev the value is `local.x1agent.dev` (matches
   * the manifests under deploy/k8s/dev/). For a GCP install the user
   * enters their own base domain (e.g. `x1agent.com`).
   */
  baseDomain: string;
  /**
   * Only set when provider === "gcp". The gcloud project ID the
   * x1agent configuration binds to. Stored in `.env.local` for the
   * hook + for future installer tooling; the actual gcloud config
   * on disk owns the real binding.
   */
  gcpProjectId?: string;
  /**
   * Only set when provider === "gcp". The Google account email that
   * has permissions on the GCP project. Same rationale as project ID.
   */
  gcpAccount?: string;
}

const DEFAULT_LOCAL_DOMAIN = "local.x1agent.dev";

export async function promptCloudTarget(
  current: Partial<CloudTarget>,
): Promise<CloudTarget | null> {
  const provider = await select<CloudProvider>({
    message: "Deployment target",
    options: [
      {
        value: "local",
        label: "Local only (OrbStack Kubernetes)",
        hint: "what you want for development",
      },
      {
        value: "gcp",
        label: "Google Cloud (GKE)",
        hint: "requires gcloud CLI + a GCP project with billing enabled",
      },
    ],
    initialValue: current.provider ?? "local",
  });
  if (isCancel(provider)) return null;

  if (provider === "local") {
    note(
      `Local-only install. Base domain will be set to ${DEFAULT_LOCAL_DOMAIN}\n` +
        `(matches the manifests under deploy/k8s/dev/). The URLs become:\n` +
        `  app.${DEFAULT_LOCAL_DOMAIN}\n` +
        `  api.${DEFAULT_LOCAL_DOMAIN}\n` +
        `  *.preview.${DEFAULT_LOCAL_DOMAIN}`,
      "Local target",
    );
    return { provider: "local", baseDomain: DEFAULT_LOCAL_DOMAIN };
  }

  // GCP path
  const baseDomain = await text({
    message: "Base domain for this deployment",
    placeholder: "x1agent.com",
    initialValue: current.baseDomain || "",
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required. The app/api/preview URLs are derived from this.";
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(t))
        return "Looks like an invalid domain — expected something like x1agent.com.";
      return undefined;
    },
  });
  if (isCancel(baseDomain)) return null;

  const gcpProjectId = await text({
    message: "GCP project ID",
    placeholder: "x1agent-prod-12345",
    initialValue: current.gcpProjectId || "",
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required. Find it in the GCP console under 'Project info'.";
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(t))
        return "GCP project IDs are 6–30 chars, lowercase alphanumeric + hyphens.";
      return undefined;
    },
  });
  if (isCancel(gcpProjectId)) return null;

  const gcpAccount = await text({
    message: "GCP account email (the Google account with access to the project)",
    placeholder: "you@example.com",
    initialValue: current.gcpAccount || "",
    validate: (v) => {
      const t = v.trim();
      if (!t) return "Required.";
      if (!/.+@.+\..+/.test(t)) return "Looks like an invalid email.";
      return undefined;
    },
  });
  if (isCancel(gcpAccount)) return null;

  note(
    `Derived URLs from base domain "${baseDomain.trim()}":\n` +
      `  app.${baseDomain.trim()}\n` +
      `  api.${baseDomain.trim()}\n` +
      `  *.preview.${baseDomain.trim()}`,
    "GCP target",
  );

  return {
    provider: "gcp",
    baseDomain: baseDomain.trim(),
    gcpProjectId: gcpProjectId.trim(),
    gcpAccount: gcpAccount.trim(),
  };
}
