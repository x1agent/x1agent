import { useEffect } from "react";
import { AppShell } from "../../shell/AppShell";

/**
 * X1A-145 — the old standalone Claude-models page now lives inside
 * /admin/settings under the Anthropic tab, alongside the API key and
 * the new summarizer-model picker. The route stays alive so old deep
 * links don't 404; on mount we redirect.
 */
export function AnthropicModelsRoot() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.location.replace("/admin/settings?tab=anthropic");
  }, []);

  return (
    <AppShell breadcrumbs={[{ label: "Model Settings" }]}>
      <div className="p-8 text-sm text-fg-muted">
        Moved to{" "}
        <a className="text-accent hover:underline" href="/admin/settings?tab=anthropic">
          Model Settings → Anthropic
        </a>
        …
      </div>
    </AppShell>
  );
}
