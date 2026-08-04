import type { RuntimeType } from "@x1agent/shared";

interface RuntimeModelChoice {
  id: string;
  label: string;
}

const PREFERRED_MODEL_MATCH: Record<RuntimeType, string> = {
  claude_code: "sonnet",
  codex: "terra",
};

/** Pick an exact harness-reported id; never synthesize a model name. */
export function pickPreferredRuntimeModel(
  runtime: RuntimeType,
  models: readonly RuntimeModelChoice[],
  harnessDefault: string | null = null,
): string {
  const query = PREFERRED_MODEL_MATCH[runtime].toLocaleLowerCase();
  const normalized = models.map((model) => ({
    model,
    id: model.id.toLocaleLowerCase(),
    label: model.label.toLocaleLowerCase(),
  }));
  const preferred =
    normalized.find(({ id }) => id === query) ??
    normalized.find(({ label }) => label === query) ??
    normalized.find(({ id }) => id.includes(query)) ??
    normalized.find(({ label }) => label.includes(query));
  if (preferred) return preferred.model.id;
  return models.some((model) => model.id === harnessDefault)
    ? (harnessDefault ?? "")
    : "";
}
