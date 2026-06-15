import {
  BarChart3,
  Boxes,
  ClipboardList,
  Database,
  Hash,
  KeyRound,
  Plug,
  ScrollText,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";

/**
 * Single source of truth for the Workspace settings sidebar.
 *
 * Sections group related settings so the IA scales with feature
 * growth — the way GitHub's settings does. Adding a feature =
 * appending a leaf under the right section, not stacking another
 * top-level tab.
 *
 * `pathSuffix` is appended to /workspaces/<slug>/settings when
 * computing the active link target — keeps the slug interpolation
 * out of this file so it stays composition-friendly.
 *
 * `placeholder = true` marks routes that exist for IA completeness
 * but have no real content yet (a "coming soon" panel renders).
 * Lets us reveal the navigation tree before the underlying feature
 * lands without breaking the muscle memory when it does.
 */

export interface SettingsLeaf {
  title: string;
  pathSuffix: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  placeholder?: boolean;
}

export interface SettingsSection {
  title: string;
  items: SettingsLeaf[];
}

export const WORKSPACE_SETTINGS_NAV: SettingsSection[] = [
  {
    title: "Infrastructure",
    items: [
      {
        title: "Shared resources",
        pathSuffix: "/infrastructure/shared-resources",
        icon: Database,
        description:
          "Postgres / Redis branches and other long-lived data agents persist into.",
      },
      {
        title: "Container registry",
        pathSuffix: "/infrastructure/registry",
        icon: Boxes,
        description: "Private OCI for stdio MCP images and runtime extensions.",
      },
    ],
  },
  {
    title: "Integrations",
    items: [
      {
        title: "Workspace secrets",
        pathSuffix: "/integrations/environment-variables",
        icon: KeyRound,
        description:
          "Encrypted values + env-var aliases that expose them to agents and preview environments.",
      },
      {
        title: "MCP servers",
        pathSuffix: "/integrations/mcp",
        icon: Plug,
        description: "Catalog of MCP servers agents can attach to.",
      },
      {
        title: "Slack",
        pathSuffix: "/integrations/slack",
        icon: Hash,
        description:
          "Configure Slack bots. Each bot gets its own name, OAuth installs into a Slack workspace, and pairs with one agent.",
      },
    ],
  },
  {
    title: "Security",
    items: [
      {
        title: "Policies",
        pathSuffix: "/security/policies",
        icon: ShieldCheck,
        description:
          "Workspace-level toggles that decide which capabilities agents are allowed to use.",
      },
    ],
  },
  {
    title: "Members",
    items: [
      {
        title: "People",
        pathSuffix: "/members/people",
        icon: Users,
        description: "Invite and manage workspace members.",
      },
      {
        title: "Access grants",
        pathSuffix: "/members/access-grants",
        icon: ShieldCheck,
        description:
          "Allow whole domains or specific emails to sign in straight into this workspace.",
      },
      {
        title: "Groups",
        pathSuffix: "/members/groups",
        icon: UserCog,
        description: "Bundle members into groups for permission scoping.",
        placeholder: true,
      },
    ],
  },
  {
    title: "Insights",
    items: [
      {
        title: "Analytics",
        pathSuffix: "/insights/analytics",
        icon: BarChart3,
        description: "Token spend by agent, user, model, and trigger source.",
      },
      {
        title: "Audit log",
        pathSuffix: "/insights/audit",
        icon: ScrollText,
        description: "Who did what, when. For compliance and incident review.",
        placeholder: true,
      },
    ],
  },
];

export const DEFAULT_SETTINGS_PATH = "/infrastructure/shared-resources";

/**
 * Flat list of every leaf, useful when the rendering side wants to
 * walk all routes (sitemap, breadcrumb resolver, redirect map).
 */
export function allSettingsLeaves(): readonly (SettingsLeaf & {
  sectionTitle: string;
})[] {
  return WORKSPACE_SETTINGS_NAV.flatMap((s) =>
    s.items.map((i) => ({ ...i, sectionTitle: s.title })),
  );
}

/**
 * Map a current pathname to the matching leaf so the active highlight
 * in the sidebar doesn't depend on string equality of the full URL.
 * Returns null if the URL isn't under /workspaces/<slug>/settings.
 */
export function leafFromPathname(
  pathname: string,
): (SettingsLeaf & { sectionTitle: string }) | null {
  const m = pathname.match(/^\/workspaces\/[^/]+\/settings(\/.+)?$/);
  if (!m) return null;
  const sub = m[1] ?? "";
  // No subpath → the operator is on the overview screen, not on any
  // leaf. Caller renders the Overview entry as active.
  if (sub === "" || sub === "/") return null;
  for (const leaf of allSettingsLeaves()) {
    if (sub === leaf.pathSuffix) return leaf;
  }
  return null;
}

// Used by Lucide icons in the sidebar; suppress unused-import warning
// for the imports above since this is a config-only module.
const _icons = {
  BarChart3,
  Boxes,
  ClipboardList,
  Database,
  Hash,
  KeyRound,
  Plug,
  ScrollText,
  UserCog,
  Users,
};
void _icons;
