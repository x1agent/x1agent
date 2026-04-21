import { isCancel, log, note, select } from "@clack/prompts";
import { runPreflight } from "./preflight.ts";
import { promptAdmin } from "./admin.ts";
import { promptAnthropic } from "./anthropic.ts";
import { promptOptionalSecrets } from "./optional-secrets.ts";
import { applyAll } from "./apply.ts";

export type SetupMode = "local";

/**
 * Top-level setup flow. Each step returns either its collected value
 * or a sentinel indicating the user cancelled. Cancellation aborts the
 * whole flow without any destructive action — nothing has been applied
 * until `applyAll` runs.
 */
export async function runSetup(): Promise<boolean> {
  note(
    "This wizard stands up a local x1agent stack on OrbStack Kubernetes.\n" +
      "Nothing is changed in the cluster until the final confirmation.",
    "Welcome",
  );

  const mode = await select<SetupMode>({
    message: "Deployment target",
    options: [
      {
        value: "local",
        label: "Local dev (OrbStack)",
        hint: "the only option right now — remote + production modes land later",
      },
    ],
    initialValue: "local",
  });
  if (isCancel(mode)) return false;

  const preflight = await runPreflight();
  if (!preflight) return false;

  const admin = await promptAdmin();
  if (!admin) return false;

  const anthropic = await promptAnthropic();
  if (!anthropic) return false;

  const optional = await promptOptionalSecrets();
  if (!optional) return false;

  log.info("Applying configuration to the cluster…");
  await applyAll({
    admin,
    anthropic,
    openai: optional.openai,
    githubPat: optional.githubPat,
  });

  note(
    `x1agent is up at http://localhost:4322\n` +
      `Sign in with: ${admin.email}\n\n` +
      `Rerun any time with:  mise run quickstart\n` +
      `Tail cluster logs:    mise run dev:cluster:logs`,
    "Ready",
  );

  return true;
}
