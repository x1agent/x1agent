---
title: Information architecture
description: Shell, navigation, and how workspace content is organized
sidebar:
  order: 5
---

x1agent has one navigation shell and one set of rules about where things live. This page defines both. The UI is binding on this structure: components and pages that drift from it should be fixed, not tolerated.

## The shell

Every authenticated page renders inside a two-column layout:

- **Left: a collapsible sidebar.** Holds platform identity, the active workspace chip with a workspace switcher, the workspace navigation menu, and the user account menu.
- **Right: the main content area.** Gets a thin site header with the page title and optional breadcrumbs, then the page itself.

On desktop the sidebar is pinned. On viewports below the `md` breakpoint it collapses to an icon-only rail; a hamburger opens it as an off-canvas drawer. The shell is built on shadcn's `Sidebar` primitive, which already handles the collapse/drawer behavior — we don't re-implement responsive logic per page.

```
┌─────────────┬───────────────────────────────────────────┐
│  x1agent    │  Agents                                    │
│ ┌─────────┐ │  ────────────────────────────────────      │
│ │ Acme ▾  │ │                                            │
│ └─────────┘ │   [page content]                           │
│             │                                            │
│  ▸ Agents   │                                            │
│  ▸ Sessions │                                            │
│  ▸ GitHub   │                                            │
│  ▸ Settings │                                            │
│             │                                            │
│ ─────────── │                                            │
│  christian  │                                            │
│  @…         │                                            │
└─────────────┴───────────────────────────────────────────┘
```

Sign-in, accept-invitation, and the landing page live outside the shell. Everything else uses it.

## Sidebar contents

### Header

- **Platform name link** (top) — routes to the active workspace's home.
- **Workspace chip** — shows the active workspace's name and the user's role in it. Clicking the chip itself opens workspace settings; clicking the trailing expander opens a dropdown listing every workspace the user is a member of plus any workspaces on the user's allowlist they haven't joined yet. Selecting a workspace calls the switch-workspace store action and reloads into the same sub-page of the new workspace where possible.

### Body

The body is a single `Platform` group with workspace-scoped nav items:

| Item     | URL                              | Purpose                                  |
|----------|----------------------------------|------------------------------------------|
| Agents   | `/workspaces/:slug`              | Agent list (also the workspace home)     |
| Sessions | `/workspaces/:slug/sessions`     | All sessions across all agents in the workspace, most recent first |
| GitHub   | `/workspaces/:slug/github`       | Installed apps + attached repos inventory |
| Settings | `/workspaces/:slug/settings`     | Workspace-level settings, members, invitations |

The sidebar never shows resources from a workspace the user isn't currently in. Switching workspace updates every URL the sidebar emits.

### Footer

A user chip with avatar, name, and email. Clicking it opens a menu:

- Linked accounts (switch between signed-in Google identities).
- **Add account** — starts the account-linking flow.
- **My account** — `/account` page.
- **My permissions** — `/me/grants`, showing the user's own rows in `permission_grants` and their status.
- **Admin settings** (platform admins only) — `/admin`.
- **Log out.**

## Page inventory

### Workspace pages

```
/workspaces/:slug                  Agents list + workspace overview
/workspaces/:slug/sessions         All sessions in the workspace
/workspaces/:slug/agents/new       Create agent (edit form, empty state)
/workspaces/:slug/agents/:slug     Agent detail (high level)
/workspaces/:slug/agents/:slug/edit Agent edit (nitty-gritty config)
/workspaces/:slug/sessions/:id     Session detail (event stream)
/workspaces/:slug/github           Installations + attached repos
/workspaces/:slug/settings         Members, invitations, workspace config
```

### Cross-workspace pages

```
/account         Platform-level account settings (linked identities, etc)
/me/grants       The user's own permission grants
/admin           Platform admin (gated on platformAdmins)
/invite/:token   Invitation accept flow
/                Landing page / sign-in
```

## Agents list (`/workspaces/:slug`)

The workspace home is the agents list. A card or table row per agent with:

- Name and slug.
- System prompt first line (truncated).
- Cadence if scheduled, else "manual only".
- A status chip summarizing the last session: "last run complete 3m ago", "running now", "no runs yet".
- Row click → agent detail.

A prominent "New agent" button sits at the top right.

## Agent detail (`/workspaces/:slug/agents/:slug`)

This is the page that replaces today's combined edit screen. The detail page is a **read-mostly summary** — everything an operator needs to understand the agent without scrolling through form inputs:

- **Header.** Name, slug, active/inactive, badge for role ("orchestrator" if the agent has any active `spawn` grants, otherwise nothing special). One **Edit** button that routes to `/edit`.
- **Tabs** across the body:

  | Tab          | Content                                                               |
  |--------------|-----------------------------------------------------------------------|
  | Overview     | Key-value summary: runtime, schedule, active/inactive, linked repos (read-only list), can-spawn allowlist (read-only list), last run status. |
  | Sessions     | The agent's session history. Filterable by status. Row-click → session detail. Run-now button at the top. |
  | Prompts      | The agent's system prompt and heartbeat text, read-only, rendered as markdown. |
  | Runs         | Chart of run counts + durations over time (eventual; drop from v1 if it slips). |

- **No form inputs on the detail page.** Anything that would accept a text change belongs on `/edit`.

The edit page keeps the existing dense form: identity, runtime, schedule, system prompt, heartbeat (conditional on schedule being set), linked repos, can-spawn allowlist. It's one scroll with a save button at the bottom. Nothing fancy; it's the configuration surface.

### Why this split

Operators mostly want "is this agent behaving right, what's it done recently, what repos is it touching" — the detail page. They want the config surface rarely, when setting up. Putting sessions on an agent detail tab instead of scattered across the workspace sessions list gives the detail page the right density: it becomes the agent's dashboard.

The workspace-level `/sessions` page still exists, for people who want to see *everything* in one stream — debugging a bad night, looking across agents. It's not the primary path.

## Session detail (`/workspaces/:slug/sessions/:id`)

Unchanged from what's already built: full-width event stream with a right-hand info sidebar and a message input at the bottom. The only addition tracked elsewhere is the **Children** panel when the session has child sessions — see [Orchestration](./orchestration).

## Sessions list (`/workspaces/:slug/sessions`)

A reverse-chronological table of every session in the workspace, regardless of agent. Columns: agent, triggered-by, status, duration, started-at. Filters for status and agent. Row click → session detail.

This is the "show me everything that ran in the last 24 hours" page. Not the primary daily-driver.

## Breadcrumbs

Every non-top-level page has breadcrumbs in the site header:

- Agent detail: `Agents / Smoke Run`
- Agent edit: `Agents / Smoke Run / Edit`
- Session detail: `Sessions / 019d...`  *(workspace-scoped sessions page is the parent, not the agent — sessions are first-class)*
- GitHub, Settings: single-segment.

## Out of scope

- **A universal search bar.** Not today. Once we have more than ~20 agents per workspace we'll want one.
- **Dashboards or analytics pages.** The `Runs` tab on an agent is the only chart view; there is no platform-level dashboard.
- **Nested workspaces.** Workspace is flat — no sub-workspaces, no projects inside a workspace.

## Links to the build

- Shell: `packages/app/src/shell/AppShell.tsx` + `packages/app/src/shell/AppSidebar.tsx`.
- Stores: `packages/app/src/stores/workspaceStore.ts` (active slug + list).
- Pages: `packages/app/src/pages/workspaces/[slug]/*.astro`.

The shell is a single component. A page that bypasses it — setting its own layout inline, omitting the sidebar — is a bug against this doc.
