import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AgentDetailRoot } from "../features/agents/AgentDetailRoot";
import { useAuthStore } from "../stores/authStore";
import { useAgentsStore } from "../stores/agentsStore";
import { useMcpStore, mcpAgentKey } from "../stores/mcpStore";
import { useAgentEnvBindingsStore } from "../stores/agentEnvBindingsStore";
import { useGitHubStore } from "../stores/githubStore";
import { useGrantsStore } from "../stores/grantsStore";
import { useCollectionsStore } from "../stores/collectionsStore";
import { useSessionsStore } from "../stores/sessionsStore";

/**
 * X1A-149 regression coverage.
 *
 * The agent detail page is read-only for workspace members and
 * editable for admin/owner. Before the fix, the page skipped
 * loadMcpAttachments / loadEnvBindings for plain members because the
 * api 403'd both. Once the api was split into read/write gates,
 * the app needed to drop that skip — otherwise members still saw
 * empty rows with no way to tell "nothing configured" from "you're
 * not allowed".
 *
 * What this test pins down:
 *   - Both the MCP and env-bindings GET endpoints are fetched on
 *     mount regardless of role.
 *   - When the stores have data, the configuration rows render the
 *     same counts a member sees as an admin would.
 *   - Members do not get an Edit button (server-side writes still 403,
 *     this is the UI half of that gate).
 */

const WS_SLUG = "default";
const AGENT_ID = "agent-1";
const AGENT_SLUG = "heartbeat";

const fetchMock = mock(
  (_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("{}")),
);
const originalFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function seedAgent() {
  useAgentsStore.setState({
    bySlug: {
      [WS_SLUG]: [
        {
          id: AGENT_ID,
          slug: AGENT_SLUG,
          name: "Heartbeat",
          runtime_type: "claude_code",
          schedule: "@hourly",
          heartbeat_md: "ping",
          system_prompt: "you are a helpful agent",
          is_active: true,
        } as never,
      ],
    },
  } as never);
}

function seedAttachments() {
  // Pre-populate so the rendered row shows "1 attached" / "1 set".
  // Without these, the bug would show up as "—" / "None" rows.
  useMcpStore.setState({
    attachmentsByAgentKey: {
      [mcpAgentKey(WS_SLUG, AGENT_ID)]: [
        {
          id: "att-1",
          agent_id: AGENT_ID,
          catalog_entry_id: "cat-1",
          env_json: {},
          tool_scopes_granted: [],
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-18T00:00:00Z",
          created_by: "user-1",
        } as never,
      ],
    },
  } as never);
  useAgentEnvBindingsStore.setState({
    byAgentKey: {
      [`${WS_SLUG}:${AGENT_ID}`]: [
        {
          id: "b-1",
          agent_id: AGENT_ID,
          env_name: "OPENAI_API_KEY",
          secret_name: "openai",
          created_at: "2026-05-18T00:00:00Z",
          updated_at: "2026-05-18T00:00:00Z",
          created_by: "user-1",
        },
      ],
    },
  } as never);
}

function setAuth(role: "admin" | "owner" | "member") {
  useAuthStore.setState({
    user: {
      id: "u_1",
      email: "u@example.com",
      name: "U",
      avatar_url: null,
    },
    memberships: [{ slug: WS_SLUG, role } as never],
    isPlatformAdmin: false,
    status: "authenticated",
    error: null,
  } as never);
}

function defaultFetches() {
  fetchMock.mockImplementation((url) => {
    const u = String(url);
    // Endpoints AppShell + child cards fire on mount. Keep them quiet.
    if (u.endsWith("/auth/accounts"))
      return Promise.resolve(jsonRes({ accounts: [] }));
    if (u.endsWith("/api/capabilities"))
      return Promise.resolve(
        jsonRes({
          capabilities: { graph: "none", vector: "none", collections: "none" },
        }),
      );
    if (u.includes("/mcp-attachments"))
      return Promise.resolve(jsonRes({ attachments: [] }));
    if (u.endsWith("/env") || u.includes("/env?"))
      return Promise.resolve(jsonRes({ bindings: [] }));
    if (u.includes("/agents/") && u.includes("/repos"))
      return Promise.resolve(jsonRes({ repos: [] }));
    if (u.includes("/agents/") && u.includes("/spawn-grants"))
      return Promise.resolve(jsonRes({ grants: [] }));
    if (u.includes("/sessions"))
      return Promise.resolve(jsonRes({ sessions: [] }));
    if (u.includes("/cost"))
      return Promise.resolve(jsonRes({ total_usd: 0, sessions: 0 }));
    return Promise.resolve(jsonRes({}));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  defaultFetches();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Reset stores between tests so role / cache don't leak.
  useGitHubStore.setState({ agentRepos: {} } as never);
  useCollectionsStore.setState({ attachmentsByAgentKey: {} } as never);
  useGrantsStore.setState({ spawnByAgent: {} } as never);
  useMcpStore.setState({ attachmentsByAgentKey: {} } as never);
  useAgentEnvBindingsStore.setState({ byAgentKey: {} } as never);
  useSessionsStore.setState({ byAgent: {} } as never);
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AgentDetailRoot — member view (X1A-149)", () => {
  it("fetches MCP attachments + env bindings for plain members", async () => {
    setAuth("member");
    seedAgent();

    render(
      <AgentDetailRoot workspaceSlug={WS_SLUG} agentSlug={AGENT_SLUG} />,
    );

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(
        urls.some((u) =>
          u.includes(`/api/workspaces/${WS_SLUG}/agents/${AGENT_ID}/mcp-attachments`),
        ),
      ).toBe(true);
      expect(
        urls.some((u) =>
          u.endsWith(`/api/workspaces/${WS_SLUG}/agents/${AGENT_ID}/env`),
        ),
      ).toBe(true);
    });
  });

  it("renders the configured counts to members and hides the Edit button", async () => {
    setAuth("member");
    seedAgent();
    seedAttachments();

    const { container, queryByText } = render(
      <AgentDetailRoot workspaceSlug={WS_SLUG} agentSlug={AGENT_SLUG} />,
    );

    // The bug surface: these rows used to render "—" for members
    // because the store stayed empty. With the fetch ungated they
    // render the actual counts.
    await waitFor(() => {
      expect(container.textContent).toContain("1 attached");
      expect(container.textContent).toContain("1 set");
    });

    // Member must not see an Edit affordance — writes are still
    // admin/owner-only on the api.
    expect(queryByText("Edit")).toBeNull();
  });

  it("renders the Edit button for admins", async () => {
    setAuth("admin");
    seedAgent();
    seedAttachments();

    const { findByText } = render(
      <AgentDetailRoot workspaceSlug={WS_SLUG} agentSlug={AGENT_SLUG} />,
    );

    expect(await findByText("Edit")).toBeTruthy();
  });
});
