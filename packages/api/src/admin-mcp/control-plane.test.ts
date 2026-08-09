import { describe, expect, test } from "bun:test";
import {
  InMemoryAgentRepository,
  type AgentGrantRepository,
} from "@x1agent/domain-agents";
import type {
  AttachmentRepository,
  AttachmentService,
  CatalogService,
} from "@x1agent/domain-mcp-catalog";
import type {
  GroupRepository,
  MembershipRepository,
} from "@x1agent/domain-workspaces";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import {
  DefaultAdminMcpControlPlane,
} from "./control-plane.js";
import type { OAuthPrincipal } from "./oauth-store.js";

const principal: OAuthPrincipal = {
  userId: "00000000-0000-4000-8000-000000000001",
  clientId: "client-1",
  scopes: [],
  expiresAt: 2_000_000_000,
};

async function fixture(role = "admin") {
  const agents = new InMemoryAgentRepository();
  const workspaceA = WorkspaceId("00000000-0000-4000-8000-00000000000a");
  const workspaceB = WorkspaceId("00000000-0000-4000-8000-00000000000b");
  const agentA = await agents.create({
    workspaceId: workspaceA,
    slug: WorkspaceSlug("agent-a"),
    name: "Agent A",
    runtimeType: "claude_code",
    kind: "orchestrator",
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: UserId("00000000-0000-4000-8000-000000000001"),
  });
  const agentB = await agents.create({
    workspaceId: workspaceB,
    slug: WorkspaceSlug("agent-b"),
    name: "Agent B",
    runtimeType: "claude_code",
    kind: "orchestrator",
    systemPrompt: "",
    heartbeatMd: "",
    schedule: null,
    createdBy: UserId("00000000-0000-4000-8000-000000000002"),
  });
  const attachmentRows = [
    {
      id: "attachment-1",
      agentId: String(agentA.id),
      catalogEntryId: "linear-1",
      envJson: {
        PUBLIC_VALUE: { kind: "value" as const, value: "do-not-return" },
        API_TOKEN: { kind: "secret" as const, ref: "LINEAR_TOKEN" },
      },
      toolScopesGranted: ["issues:read"],
      createdAt: new Date("2026-08-04T00:00:00Z"),
      updatedAt: new Date("2026-08-04T00:00:00Z"),
      createdBy: "user-1",
    },
  ];
  const attachmentRepository = {
    listByAgent: async () => attachmentRows,
    getById: async () => null,
    upsert: async () => attachmentRows[0]!,
    delete: async () => true,
    countByCatalogEntry: async () => 0,
  } as AttachmentRepository;
  const attachments = {
    list: async () => attachmentRows,
    attach: async () => attachmentRows[0]!,
    detach: async () => true,
  } as unknown as AttachmentService;
  const controlPlane = new DefaultAdminMcpControlPlane({
    workspaces: {
      listForUser: async () => [],
      getForUser: async (_userId, slug) =>
        slug === "default"
          ? {
              id: String(workspaceA),
              slug,
              name: "Default",
              role,
              oauthMcpsOnOrchestrators: "on",
              createdAt: "2026-08-04T00:00:00.000Z",
            }
          : null,
    },
    agents,
    agentGrants: {
      listVerbsForResolver: async () => new Set(),
    } as unknown as AgentGrantRepository,
    groups: {
      listGroupIdsForUser: async () => [],
    } as unknown as GroupRepository,
    memberships: {
      findByUserAndWorkspace: async () => null,
    } as unknown as MembershipRepository,
    catalog: {
      list: async () => [
        {
          id: "mcp-sensitive",
          workspaceId: String(workspaceA),
          name: "sensitive",
          displayName: "Sensitive",
          kind: "remote_oauth",
          image: null,
          command: "server",
          args: ["--api-key", "literal-key", "--token=literal-token", "--safe", "ok"],
          url: "https://user:password@example.test/mcp?api_key=query-secret&mode=safe",
          manifest: { env: {}, tool_scopes: {} },
          description: "",
          createdBy: principal.userId,
          createdAt: new Date("2026-08-04T00:00:00Z"),
          updatedAt: new Date("2026-08-04T00:00:00Z"),
        },
      ],
    } as unknown as CatalogService,
    attachments,
    attachmentRepository,
    installations: {} as never,
    githubClient: null,
    agentRepos: {} as never,
    permissionGrants: {} as never,
    operationStore: {} as never,
    imageCatalog: {
      get: async (workspaceId: string, imageId: string) => {
        if (workspaceId === String(workspaceA) && imageId === "image-a") {
          return { id: imageId };
        }
        throw new Error("image not found");
      },
    } as never,
    previewEnvironments: {} as never,
    collectionControl: {} as never,
    collections: {} as never,
    sessions: {} as never,
    sessionEvents: {} as never,
    sessionShares: {} as never,
    platformAdminGuard: {} as never,
    agentCollaborateResolver: async () => false,
    tokenUsage: {} as never,
    contextFiles: {} as never,
    ociImages: {} as never,
  });
  return { controlPlane, agentA, agentB };
}

describe("administrative MCP control plane security", () => {
  test("masks cross-workspace agent identifiers", async () => {
    const { controlPlane, agentB } = await fixture();
    await expect(
      controlPlane.getAgent(principal, {
        workspace: "default",
        agent: String(agentB.id),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("redacts literal attachment environment values", async () => {
    const { controlPlane, agentA } = await fixture();
    const result = await controlPlane.listMcpAttachments(principal, {
      workspace: "default",
      agent: String(agentA.id),
    });
    expect(result).toMatchObject({
      attachments: [
        {
          environment: {
            PUBLIC_VALUE: { kind: "value", value: "[redacted]" },
            API_TOKEN: { kind: "secret", ref: "LINEAR_TOKEN" },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("do-not-return");
  });

  test("requires edit access before attaching an MCP", async () => {
    const { controlPlane, agentA } = await fixture("member");
    const memberPrincipal = {
      ...principal,
      userId: "00000000-0000-4000-8000-000000000003",
    };
    await expect(
      controlPlane.setMcpAttachment(memberPrincipal, {
        workspace: "default",
        agent: String(agentA.id),
        mcp_configuration: "linear-1",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("rejects worker image IDs outside the selected workspace", async () => {
    const { controlPlane, agentA } = await fixture();
    await expect(
      controlPlane.updateAgent(principal, {
        workspace: "default",
        agent: String(agentA.id),
        expected_updated_at: agentA.updatedAt.toISOString(),
        image_id: "image-from-another-workspace",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("redacts secret-like MCP arguments and URL credentials", async () => {
    const { controlPlane } = await fixture();
    const result = await controlPlane.listMcpConfigurations(principal, {
      workspace: "default",
    });
    expect(result).toMatchObject({
      mcp_configurations: [
        {
          args: ["--api-key", "[redacted]", "--token=[redacted]", "--safe", "ok"],
          url: "https://redacted:redacted@example.test/mcp?api_key=%5Bredacted%5D&mode=safe",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("literal-key");
    expect(JSON.stringify(result)).not.toContain("literal-token");
    expect(JSON.stringify(result)).not.toContain("query-secret");
  });
});
