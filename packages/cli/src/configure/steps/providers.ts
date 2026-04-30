import { isCancel, log, select } from "@clack/prompts";

/**
 * Per-domain provider selection. Empty string means "no provider" — the
 * helm chart sets PROVIDER_<DOMAIN>=none and the api flips the
 * corresponding capability to false, so the UI hides any surface that
 * depends on it.
 *
 * Today only the graph domain has a real implementation (surrealdb).
 * Vector is folded into the graph provider in v1 (graph-surrealdb
 * provides both subjects from one pod), so picking a graph provider
 * also lights up vector. Splitting them is a future change.
 */
export interface ProviderChoices {
  graph: "surrealdb" | "";
  vector: "surrealdb" | "";
}

export async function promptProviders(
  current: { graph?: string; vector?: string },
): Promise<ProviderChoices | null> {
  const graph = await select<ProviderChoices["graph"]>({
    message: "Graph + vector provider?",
    options: [
      {
        value: "surrealdb",
        label: "SurrealDB",
        hint: "in-cluster surrealdb pod, provides both graph and vector",
      },
      {
        value: "",
        label: "None",
        hint: "Collections / record types / vector search hidden in UI",
      },
    ],
    initialValue: (current.graph as ProviderChoices["graph"]) ?? "surrealdb",
  });
  if (isCancel(graph)) return null;

  if (graph === "") {
    log.info(
      "Skipping graph + vector. The Collections tab and any UI that" +
        " depends on a graph/vector store will be hidden in this deployment.",
    );
  }

  // Vector tracks graph in v1 — same pod implements both subjects.
  return { graph, vector: graph };
}
