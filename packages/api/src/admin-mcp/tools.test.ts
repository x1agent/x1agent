import { describe, expect, test } from "bun:test";
import type { OAuthPrincipal } from "./oauth-store.js";
import { AdminMcpTools, ADMIN_MCP_SCOPES } from "./tools.js";
import type { AdminMcpControlPlane } from "./control-plane.js";
import type { AdminMcpOperationStore } from "./operation-store.js";
import type { AdminMcpWorkspaceReader } from "./workspace-reader.js";

const principal: OAuthPrincipal = {
  userId: "user-1",
  clientId: "client-1",
  scopes: [...ADMIN_MCP_SCOPES],
  expiresAt: 2_000_000_000,
};

function fixture() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const controlPlane = new Proxy(
    {},
    {
      get: (_target, property) => async (_principal: OAuthPrincipal, input: unknown) => {
        calls.push({ name: String(property), input });
        return { ok: true };
      },
    },
  ) as AdminMcpControlPlane;
  const workspaces: AdminMcpWorkspaceReader = {
      listForUser: async () => [
        {
          id: "workspace-1",
          slug: "default",
          name: "Default",
          role: "owner",
          oauthMcpsOnOrchestrators: "on",
          createdAt: "2026-08-04T00:00:00.000Z",
        },
      ],
      getForUser: async (_userId, slug) =>
        slug === "default"
          ? {
              id: "workspace-1",
              slug,
              name: "Default",
              role: "owner",
              oauthMcpsOnOrchestrators: "on",
              createdAt: "2026-08-04T00:00:00.000Z",
            }
          : null,
    };
  const tools = new AdminMcpTools(workspaces, controlPlane);
  return { tools, calls, workspaces, controlPlane };
}

describe("administrative MCP tool catalog", () => {
  test("filters discovery by the token's granted scopes", () => {
    const { tools } = fixture();
    const readOnly = tools.list({
      ...principal,
      scopes: ["x1.workspaces.read", "x1.agents.read"],
    });
    expect(readOnly.map((tool) => tool.name)).toEqual([
      "documentation.search",
      "documentation.read",
      "workspaces.list",
      "workspaces.get",
      "agents.list",
      "agents.get",
      "agents.context.inspect",
      "agents.context_files.list",
      "agents.context_files.get",
      "agents.validate_configuration",
    ]);
    expect(tools.list(principal).map((tool) => tool.name)).toContain(
      "agents.mcp_attachments.set",
    );
  });

  test("publishes the complete approved catalog with retry-safe mutations", () => {
    const { tools } = fixture();
    const catalog = tools.list(principal);
    expect(catalog.map((tool) => tool.name)).toEqual([
      "documentation.search", "documentation.read",
      "workspaces.list", "workspaces.get",
      "agents.list", "agents.get", "agents.create", "agents.update", "agents.delete",
      "agents.context.inspect", "agents.context_files.list",
      "agents.context_files.get", "agents.context_files.put",
      "agents.context_files.delete", "agents.validate_configuration",
      "repositories.installations.list", "repositories.available.list",
      "agents.repositories.list", "agents.repositories.attach",
      "agents.repositories.update", "agents.repositories.detach",
      "agents.spawn_grants.list", "agents.spawn_grants.create",
      "agents.spawn_grants.revoke", "collections.list", "collections.get",
      "collections.create", "collections.update", "collections.delete",
      "collections.retry_provision", "agents.collections.list",
      "agents.collections.set", "worker_images.list", "worker_images.get",
      "worker_images.create_from_dockerfile", "worker_images.register_oci",
      "worker_images.update", "worker_images.rebuild", "worker_images.delete",
      "artifacts.list", "artifacts.read", "costs.session.get",
      "costs.session_tree.get", "costs.agent.get", "costs.workspace.get",
      "sessions.list", "sessions.get", "sessions.events", "sessions.trigger",
      "sessions.cancel", "preview_environments.list", "preview_environments.get",
      "mcp_configurations.list", "mcp_configurations.get",
      "mcp_configurations.create", "mcp_configurations.update",
      "mcp_configurations.delete", "agents.mcp_attachments.list",
      "agents.mcp_attachments.set", "agents.mcp_attachments.remove",
    ]);
    for (const tool of catalog) {
      if (tool.annotations.readOnlyHint) continue;
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties?.idempotency_key).toBeDefined();
      expect(schema.required).toContain("idempotency_key");
    }
  });

  test("dispatches every published tool instead of advertising dead entries", async () => {
    const { tools } = fixture();
    const overrides: Record<string, unknown> = {
      workspace: "default",
      query: "agent setup",
      uri: "x1agent://docs/overview",
      installation_id: 1,
      idempotency_key: "catalog-contract",
      expected_updated_at: "2026-08-04T00:00:00.000Z",
      expected_agent_updated_at: "2026-08-04T00:00:00.000Z",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-02T00:00:00.000Z",
      mime_type: "text/plain",
      content: "test",
      path: "context.md",
      task: "validate this agent",
      manifest: { env: {}, tool_scopes: {} },
    };
    for (const tool of tools.list(principal)) {
      const schema = tool.inputSchema as {
        required?: string[];
        properties?: Record<
          string,
          { type?: string | string[]; enum?: unknown[] }
        >;
      };
      const args: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        if (key in overrides) {
          args[key] = overrides[key];
          continue;
        }
        const property = schema.properties?.[key];
        if (property?.enum?.length) args[key] = property.enum[0];
        else if (property?.type === "integer") args[key] = 1;
        else if (property?.type === "array") args[key] = [];
        else if (property?.type === "object") args[key] = {};
        else if (property?.type === "boolean") args[key] = true;
        else args[key] = `${key}-1`;
      }
      const response = await tools.call(principal, tool.name, args);
      expect(
        (response as { isError?: boolean }).isError,
        `${tool.name} must have a live dispatcher`,
      ).toBeUndefined();
    }
  });

  test("dispatches attachment updates with normalized identifiers", async () => {
    const { tools, calls } = fixture();
    const response = await tools.call(
      principal,
      "agents.mcp_attachments.set",
      {
        workspace: " default ",
        agent: " agent-1 ",
        mcp_configuration: " linear-1 ",
      },
    );
    expect((response as { isError?: boolean }).isError).toBeUndefined();
    expect(calls).toEqual([
      {
        name: "setMcpAttachment",
        input: {
          workspace: "default",
          agent: "agent-1",
          mcp_configuration: "linear-1",
          environment: undefined,
          tool_scopes: undefined,
        },
      },
    ]);
  });

  test("returns a structured forbidden error for tools outside the grant", async () => {
    const { tools } = fixture();
    const response = await tools.call(
      { ...principal, scopes: ["x1.workspaces.read"] },
      "agents.delete",
      { workspace: "default", agent: "agent-1", confirm_id: "agent-1" },
    );
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: "forbidden" },
    });
  });

  test("checks current scopes before idempotency replay", async () => {
    const { workspaces, controlPlane } = fixture();
    let claims = 0;
    const operationStore = {
      claim: async () => {
        claims += 1;
        return { kind: "replay" as const, result: { deleted: true } };
      },
    } as unknown as AdminMcpOperationStore;
    const tools = new AdminMcpTools(workspaces, controlPlane, operationStore);
    const response = await tools.call(
      { ...principal, scopes: ["x1.workspaces.read"] },
      "agents.delete",
      {
        workspace: "default",
        agent: "agent-1",
        confirm_id: "agent-1",
        idempotency_key: "old-authorized-operation",
      },
    );
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(claims).toBe(0);
  });

  test("does not expose unexpected database or provider error details", async () => {
    const tools = new AdminMcpTools({
      listForUser: async () => {
        const error = new Error("password=secret postgres://internal-host");
        Object.assign(error, { code: "ECONNREFUSED" });
        throw error;
      },
      getForUser: async () => null,
    });

    const response = await tools.call(principal, "workspaces.list", {});
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: {
        code: "internal_error",
        message: "Administrative MCP operation failed",
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain("secret");
    expect(JSON.stringify(response.structuredContent)).not.toContain("internal-host");
  });

  test("returns structured validation errors before an idempotency claim", async () => {
    const { workspaces, controlPlane } = fixture();
    const tools = new AdminMcpTools(
      workspaces,
      controlPlane,
      {} as AdminMcpOperationStore,
    );

    const response = await tools.call(principal, "agents.delete", {
      workspace: "default",
      agent: "agent-1",
      confirm_id: "agent-1",
    });
    expect((response as { isError?: boolean }).isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: { code: "validation_error", details: { field: "idempotency_key" } },
    });
  });

  test("audit-records idempotent replays with the response request ID", async () => {
    const { workspaces, controlPlane, calls } = fixture();
    const audits: Array<Record<string, unknown>> = [];
    const operationStore = {
      claim: async () => ({
        kind: "replay" as const,
        result: { deleted: true, workspace_id: "workspace-1" },
      }),
      complete: async () => undefined,
      fail: async () => undefined,
      audit: async (input: Record<string, unknown>) => {
        audits.push(input);
      },
    } as unknown as AdminMcpOperationStore;
    const tools = new AdminMcpTools(workspaces, controlPlane, operationStore);

    const response = await tools.call(principal, "agents.delete", {
      workspace: "default",
      agent: "agent-1",
      confirm_id: "agent-1",
      idempotency_key: "delete-agent-1",
    });

    expect(calls).toHaveLength(0);
    expect(response.structuredContent).toMatchObject({
      deleted: true,
      replayed: true,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: "workspace-1",
      outcome: "success",
      requestId: response.structuredContent.request_id,
    });
  });
});
