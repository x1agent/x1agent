import { Cpu, LayoutGrid, Users } from "lucide-react";

/**
 * Single source of truth for the global admin section. Used by the
 * sidebar's Admin group and by the /admin/ landing page so the two
 * stay in sync. Workspace-scoped pages live under /workspaces/:slug;
 * everything here is cluster-wide and platform-admin gated.
 */
export interface AdminNavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}

export const ADMIN_NAV: AdminNavItem[] = [
  {
    title: "Overview",
    href: "/admin",
    icon: LayoutGrid,
    description: "Cluster summary and admin entry points.",
  },
  {
    title: "Workspaces",
    href: "/admin/workspaces",
    icon: Users,
    description: "Every workspace in the deployment with member and agent counts.",
  },
  {
    title: "Model Settings",
    href: "/admin/settings",
    icon: Cpu,
    description:
      "LLM provider keys, model curation, summarizer model — all in one tabbed page.",
  },
];
