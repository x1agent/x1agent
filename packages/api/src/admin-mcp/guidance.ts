export interface GuidancePage {
  uri: string;
  title: string;
  description: string;
  text: string;
}

export const ADMIN_MCP_GUIDANCE: readonly GuidancePage[] = [
  {
    uri: "x1agent://docs/overview",
    title: "X1Agent overview",
    description: "Core concepts and the safe administrative workflow.",
    text: `# X1Agent overview

X1Agent is a self-hosted substrate for durable AI agents. Administrative MCP operations act as the authenticated human and re-check live workspace and resource permissions on every call.

Safe workflow: discover a workspace; inspect existing agents and available dependencies; create or update an agent; attach repositories, ready collections, MCP configurations, context files, worker images, and spawn grants; run agents.validate_configuration; trigger a bounded validation session; inspect events, artifacts, and costs.

Never assume an ID belongs to the selected workspace. Never put secrets in prompts, Heartbeat.md, context files, Dockerfiles, or literal MCP environment values.`,
  },
  {
    uri: "x1agent://docs/concepts/agents",
    title: "Agents",
    description: "Workers, scheduled agents, configuration, and ownership.",
    text: `# Agents

A worker performs bounded tasks and may run concurrently. A scheduled agent is a worker woken by its cron schedule. An orchestrator is a long-lived singleton that coordinates work and may spawn only explicitly granted child agents.

The system prompt defines role and boundaries. Heartbeat.md defines what an orchestrator or scheduled agent does when woken and its measurable stop/report conditions. MCP-created agents belong to the authenticated human.`,
  },
  {
    uri: "x1agent://docs/concepts/context",
    title: "Agent context",
    description: "How prompts, files, repositories, skills, collections, and MCPs fit together.",
    text: `# Agent context

Use the system prompt for durable behavioral boundaries, Heartbeat.md for wake behavior, managed context files for compact stable reference material, repositories for versioned working material, skill sources for reusable procedures, collections for evolving shared facts, MCP attachments for live systems, and artifacts for reviewable outputs.

Context files are bounded, versioned, non-secret, and mounted read-only into new sessions. Running sessions retain their snapshotted configuration.`,
  },
  {
    uri: "x1agent://docs/concepts/permissions",
    title: "Permissions",
    description: "OAuth scopes, workspace roles, grants, and visibility.",
    text: `# Permissions

OAuth scope never creates a workspace privilege. Each operation intersects token scope, installation/workspace enablement, current membership, capability flags, and resource policy. Cross-workspace IDs are masked as not found.

Agent view, invoke, collaborate, and edit are distinct. Session and artifact visibility is based on the exact owning session; seeing an agent does not reveal every private session. Only humans with owner/admin authority create spawn grants.`,
  },
  {
    uri: "x1agent://docs/concepts/collections",
    title: "Collections",
    description: "Provisioning lifecycle and agent attachment rules.",
    text: `# Collections

Collections are workspace-scoped knowledge stores. Creation is asynchronous: poll collections.get until ready or failed. retry_provision reuses the same logical collection. Only ready collections can be attached to agents. Attached collections block deletion.`,
  },
  {
    uri: "x1agent://docs/concepts/mcp-connections",
    title: "MCP connections",
    description: "Workspace catalog entries, agent attachments, OAuth, and secrets.",
    text: `# MCP connections

Workspace MCP configurations describe stdio or remote OAuth servers. Agent attachments select a configuration, tool scopes, and environment bindings. Outputs redact outbound OAuth tokens, secret values, and literal environment values. OAuth MCPs on orchestrators obey workspace policy.`,
  },
  {
    uri: "x1agent://docs/concepts/worker-images",
    title: "Worker images",
    description: "Dockerfile builds, OCI registration, polling, and readiness.",
    text: `# Worker images

Dockerfile builds and OCI validation are asynchronous. Poll worker_images.get. OCI references must be digest-pinned and use an allowlisted registry. Only ready/succeeded images may launch. An explicitly configured missing, failed, or pending image fails clearly; X1Agent does not silently fall back.`,
  },
  {
    uri: "x1agent://docs/concepts/costs",
    title: "Costs",
    description: "Visibility-filtered token and model-cost estimates.",
    text: `# Costs

Cost tools report token usage and estimated model cost in USD, not provider invoices. They exclude infrastructure and third-party API charges. Session-tree and non-admin agent rollups remove inaccessible sessions from rows and totals and mark visibility_filtered when coverage is partial.`,
  },
  {
    uri: "x1agent://docs/recipes/agent-setup",
    title: "Agent setup recipe",
    description: "End-to-end create, validate, test, and inspect loop.",
    text: `# Agent setup recipe

1. Call workspaces.list.
2. Discover repositories, ready collections, MCP configurations, and worker images.
3. Create the agent with a stable idempotency key.
4. Add explicit relationship resources and compact context files.
5. Call agents.context.inspect and agents.validate_configuration.
6. Fix every error and review warnings.
7. Call sessions.trigger with a bounded test task and idempotency key.
8. Poll sessions.get/events, then inspect artifacts and costs.
9. Cancel the validation run if it is no longer needed.`,
  },
];

export function readGuidance(uri: string): GuidancePage | null {
  return ADMIN_MCP_GUIDANCE.find((page) => page.uri === uri) ?? null;
}

export function searchGuidance(query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return ADMIN_MCP_GUIDANCE.map((page) => {
    const haystack = `${page.title} ${page.description} ${page.text}`.toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { page, score };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.uri.localeCompare(b.page.uri))
    .slice(0, 10)
    .map(({ page }) => ({
      uri: page.uri,
      title: page.title,
      description: page.description,
      snippet: page.text.replace(/\s+/g, " ").slice(0, 360),
    }));
}
