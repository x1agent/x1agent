/**
 * Curated MCP server seed.
 *
 * Goal: when an operator types "linear" they see a single row with a
 * recognizable logo, click Install, and land in the add-form with
 * sensible defaults pre-filled. They can then verify and click Save.
 *
 * Why in-repo and not pulled from a public registry: third-party
 * registries (Smithery, mcp.so, Anthropic's official one) move faster
 * than our trust in their stability does, and going down or pivoting
 * shouldn't break our install path. A curated list of ~25 well-known
 * MCPs covers the operator's common case; rarer servers fall through
 * to the existing free-form "Custom MCP" field.
 *
 * Field sources (as of ship time — verify before relying for billing):
 *   `mcp_url`     — provider's published endpoint or the upstream
 *                   reference repo's documented URL. Some are best
 *                   guesses; the picker exposes them as editable
 *                   defaults rather than read-only values.
 *   `simple_icon` — the slug from simpleicons.org. The browser
 *                   loads the SVG directly from a CDN; no bundling.
 *
 * `mcp_url: null` means "we know this server exists but the URL
 * varies per tenant or wasn't publicly stable enough to bake in" —
 * the picker prompts the operator to paste the URL from the homepage.
 */

export type SeedKind = "remote_oauth" | "command" | "image";

export interface McpSeedEntry {
  /** Short id used as the catalog name (lowercase, hyphens only). */
  slug: string;
  /** Display name shown in the picker. */
  display_name: string;
  /** One-line description shown under the name. */
  description: string;
  /** simpleicons.org slug for the brand logo. */
  simple_icon?: string;
  /** Provider homepage so operators can verify / find docs. */
  homepage: string;
  /** Catalog kind. */
  kind: SeedKind;
  /** For `remote_oauth` — the MCP server URL the api will discover. */
  mcp_url?: string | null;
  /** For `command` kind — the binary (npx, uvx, etc.). */
  command?: string;
  /** For `command` kind — args, one per element. */
  args?: string[];
  /** For `image` kind — the OCI image ref. */
  image?: string;
  /** Tags for search ranking ("crm", "git", "files"). */
  tags?: readonly string[];
}

export const MCP_SEED: readonly McpSeedEntry[] = [
  // ── Remote-OAuth (hosted) ──────────────────────────────────────────
  {
    slug: "linear",
    display_name: "Linear",
    description:
      "Issues, projects, sprints. OAuth into your Linear workspace.",
    simple_icon: "linear",
    homepage: "https://linear.app/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.linear.app/sse",
    tags: ["issues", "tickets", "project-management"],
  },
  {
    slug: "notion",
    display_name: "Notion",
    description: "Pages, databases, docs. Read and edit Notion content.",
    simple_icon: "notion",
    homepage: "https://www.notion.so/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.notion.com/mcp",
    tags: ["docs", "wiki", "knowledge"],
  },
  {
    slug: "sentry",
    display_name: "Sentry",
    description: "Error monitoring, issue tracking, release health.",
    simple_icon: "sentry",
    homepage: "https://sentry.io/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.sentry.dev/mcp",
    tags: ["errors", "observability", "monitoring"],
  },
  {
    slug: "mercury",
    display_name: "Mercury",
    description: "Banking. Read account balances, list transactions.",
    simple_icon: "mercury",
    homepage: "https://mercury.com/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.mercury.com/mcp",
    tags: ["banking", "finance", "treasury"],
  },
  {
    slug: "stripe",
    display_name: "Stripe",
    description: "Payments, customers, subscriptions, invoices.",
    simple_icon: "stripe",
    homepage: "https://stripe.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["payments", "billing", "finance"],
  },
  {
    slug: "atlassian",
    display_name: "Atlassian (Jira + Confluence)",
    description: "Jira issues, Confluence pages, sprint boards.",
    simple_icon: "atlassian",
    homepage: "https://www.atlassian.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["issues", "tickets", "wiki"],
  },
  {
    slug: "asana",
    display_name: "Asana",
    description: "Tasks, projects, teams. Read and update workspace work.",
    simple_icon: "asana",
    homepage: "https://asana.com/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.asana.com/sse",
    tags: ["tasks", "project-management"],
  },
  {
    slug: "slack",
    display_name: "Slack",
    description: "Channels, messages, threads, users.",
    simple_icon: "slack",
    homepage: "https://slack.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["messaging", "chat"],
  },
  {
    slug: "github",
    display_name: "GitHub",
    description: "Repos, issues, PRs, code search via GitHub's MCP.",
    simple_icon: "github",
    homepage: "https://github.com/",
    kind: "remote_oauth",
    mcp_url: "https://api.githubcopilot.com/mcp/",
    tags: ["code", "git", "issues", "pr"],
  },
  {
    slug: "cloudflare",
    display_name: "Cloudflare",
    description: "Workers, DNS, zones. Manage Cloudflare resources.",
    simple_icon: "cloudflare",
    homepage: "https://www.cloudflare.com/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.cloudflare.com/mcp",
    tags: ["dns", "edge", "infrastructure"],
  },
  {
    slug: "hubspot",
    display_name: "HubSpot",
    description: "CRM contacts, companies, deals, marketing.",
    simple_icon: "hubspot",
    homepage: "https://www.hubspot.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["crm", "sales", "marketing"],
  },
  {
    slug: "google-drive",
    display_name: "Google Drive",
    description: "Files and folders. Search and read Drive contents.",
    simple_icon: "googledrive",
    homepage: "https://drive.google.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["files", "docs", "google"],
  },
  {
    slug: "google-calendar",
    display_name: "Google Calendar",
    description: "Events, schedules, meetings.",
    simple_icon: "googlecalendar",
    homepage: "https://calendar.google.com/",
    kind: "remote_oauth",
    mcp_url: null,
    tags: ["calendar", "scheduling", "google"],
  },
  {
    slug: "intercom",
    display_name: "Intercom",
    description: "Support conversations, tickets, customer profiles.",
    simple_icon: "intercom",
    homepage: "https://www.intercom.com/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.intercom.com/sse",
    tags: ["support", "customer", "messaging"],
  },
  {
    slug: "zapier",
    display_name: "Zapier",
    description: "Trigger any of 8000+ Zapier-connected apps.",
    simple_icon: "zapier",
    homepage: "https://zapier.com/",
    kind: "remote_oauth",
    mcp_url: "https://mcp.zapier.com/mcp",
    tags: ["automation", "integrations"],
  },

  // ── Stdio reference servers (modelcontextprotocol/servers) ─────────
  {
    slug: "filesystem",
    display_name: "Filesystem",
    description: "Read, write, list files in a sandboxed directory.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    tags: ["files", "fs", "reference"],
  },
  {
    slug: "fetch",
    display_name: "Fetch",
    description: "HTTP GET arbitrary URLs and return parsed text.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    kind: "command",
    command: "uvx",
    args: ["mcp-server-fetch"],
    tags: ["http", "web", "scraping", "reference"],
  },
  {
    slug: "git",
    display_name: "Git",
    description: "Run git commands against a local repo.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    kind: "command",
    command: "uvx",
    args: ["mcp-server-git"],
    tags: ["git", "vcs", "reference"],
  },
  {
    slug: "postgres",
    display_name: "Postgres",
    description: "Run SELECT queries against a Postgres database.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    tags: ["database", "sql", "reference"],
  },
  {
    slug: "memory",
    display_name: "Memory",
    description: "Persistent knowledge-graph for the agent across sessions.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    tags: ["memory", "graph", "reference"],
  },
  {
    slug: "puppeteer",
    display_name: "Puppeteer",
    description: "Headless Chrome — navigate and screenshot pages.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    tags: ["browser", "scraping", "reference"],
  },
  {
    slug: "sequential-thinking",
    display_name: "Sequential thinking",
    description: "Scratchpad / chain-of-thought tool for the agent.",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    tags: ["reasoning", "reference"],
  },
  {
    slug: "time",
    display_name: "Time",
    description: "Time / timezone utilities (now, convert, format).",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    kind: "command",
    command: "uvx",
    args: ["mcp-server-time"],
    tags: ["time", "timezone", "reference"],
  },
  {
    slug: "brave-search",
    display_name: "Brave Search",
    description: "Web search via Brave's API.",
    simple_icon: "brave",
    homepage:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    kind: "command",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    tags: ["search", "web"],
  },
];

/**
 * Default JSON manifest stub — operators rarely need to edit this for
 * remote_oauth servers (which discover their tools dynamically) but
 * the field is required by the catalog API.
 */
export const DEFAULT_MANIFEST = `{
  "env": {},
  "tool_scopes": {}
}`;

/**
 * Stable simpleicons.org CDN URL pattern. We don't bundle the SVG
 * library — fetch on demand from jsDelivr's mirror so the bundle
 * size doesn't grow with every new logo we want to support.
 */
export function simpleIconUrl(slug: string): string {
  return `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`;
}

/**
 * Tiny search ranker. Exact-prefix on slug or display_name beats a
 * substring match in the description; tags rank below name. Returns
 * entries in best-match-first order.
 */
export function searchSeed(query: string): readonly McpSeedEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return MCP_SEED;
  return [...MCP_SEED]
    .map((e) => ({ entry: e, score: scoreEntry(e, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entry);
}

function scoreEntry(e: McpSeedEntry, q: string): number {
  const slug = e.slug.toLowerCase();
  const name = e.display_name.toLowerCase();
  if (slug === q || name === q) return 100;
  if (slug.startsWith(q) || name.startsWith(q)) return 80;
  if (slug.includes(q) || name.includes(q)) return 60;
  if ((e.tags ?? []).some((t) => t.toLowerCase() === q)) return 50;
  if ((e.tags ?? []).some((t) => t.toLowerCase().includes(q))) return 30;
  if (e.description.toLowerCase().includes(q)) return 20;
  return 0;
}
