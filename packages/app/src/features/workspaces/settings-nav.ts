import {
  BarChart3,
  Boxes,
  ClipboardList,
  Database,
  KeyRound,
  Plug,
  ScrollText,
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
        title: "Environment variables",
        pathSuffix: "/integrations/environment-variables",
        icon: KeyRound,
        description: "Secret refs that env-bindings and MCPs reference.",
      },
      {
        title: "MCP servers",
        pathSuffix: "/integrations/mcp",
        icon: Plug,
        description: "Catalog of MCP servers agents can attach to.",
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
  for (const leaf of allSettingsLeaves()) {
    if (sub === leaf.pathSuffix) return leaf;
  }
  // No subpath → land on the default leaf.
  if (sub === "" || sub === "/") {
    const fallback = allSettingsLeaves().find(
      (l) => l.pathSuffix === DEFAULT_SETTINGS_PATH,
    );
    return fallback ?? null;
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
  KeyRound,
  Plug,
  ScrollText,
  UserCog,
  Users,
};
void _icons;
