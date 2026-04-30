import { isCancel, select } from "@clack/prompts";
import { listDeployments } from "../configure/paths.ts";

/**
 * Pick which deployment file an install/terraform action operates on.
 * Resolution order:
 *   1. X1AGENT_DEPLOYMENT env var (operator already chose; honor it)
 *   2. Single existing deployment file (zero-config common case)
 *   3. Multiple deployment files → Clack select prompt
 *   4. Zero deployment files → null (caller surfaces error)
 *
 * Side effect: sets process.env.X1AGENT_DEPLOYMENT to the chosen value
 * so downstream `resolveActiveDeployment()` picks it up without
 * threading the choice through every function.
 *
 * Returns the chosen base domain, or null on no-deployment / cancel.
 */
export async function selectDeployment(): Promise<string | null> {
  if (process.env.X1AGENT_DEPLOYMENT?.trim()) {
    return process.env.X1AGENT_DEPLOYMENT.trim();
  }

  const deployments = listDeployments();
  if (deployments.length === 0) return null;
  if (deployments.length === 1) {
    process.env.X1AGENT_DEPLOYMENT = deployments[0];
    return deployments[0]!;
  }

  const choice = await select<string>({
    message: "Multiple deployments found — pick one:",
    options: deployments.map((d) => ({ value: d, label: d })),
    initialValue: deployments[0],
  });
  if (isCancel(choice)) return null;
  process.env.X1AGENT_DEPLOYMENT = choice;
  return choice;
}
