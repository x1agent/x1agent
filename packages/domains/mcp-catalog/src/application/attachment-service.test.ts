import { describe, it, expect, beforeEach } from "bun:test";
import { AttachmentService } from "./attachment-service.js";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type { CatalogRepository } from "../ports/catalog-repository.js";
import type { AttachmentRepository, AttachmentUpsertInput } from "../ports/attachment-repository.js";
import type { Attachment } from "../domain/attachment.js";
import { ValidationError } from "@x1agent/kernel";

const ENTRY: CatalogEntry = {
  id: "entry-1",
  workspaceId: "ws-1",
  name: "linear" as CatalogName,
  displayName: "Linear",
  image: "ghcr.io/x/linear-mcp:1",
  command: null,
  args: [],
  manifest: {
    env: {
      LINEAR_API_KEY: { kind: "secret", required: true },
      LINEAR_TEAM_ID: { kind: "value", required: false },
    },
    tool_scopes: {
      create_issue: ["linear.write"],
      search_issues: ["linear.read"],
    },
  },
  description: "",
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
};

class FakeCatalog implements CatalogRepository {
  private byId: Record<string, CatalogEntry> = { [ENTRY.id]: ENTRY };
  list = async (_: string) => Object.values(this.byId);
  getById = async (ws: string, id: string) =>
    this.byId[id] && this.byId[id].workspaceId === ws ? this.byId[id] : null;
  getByName = async (_ws: string, _name: CatalogName) => null;
  upsert = async (_: never) => ENTRY;
  delete = async (_: string, _id: string) => true;
}

class FakeAttachments implements AttachmentRepository {
  saved: AttachmentUpsertInput | null = null;
  listByAgent = async (_: string) => [] as Attachment[];
  getById = async (_: string, _id: string) => null;
  upsert = async (input: AttachmentUpsertInput) => {
    this.saved = input;
    return {
      id: "att-1",
      agentId: input.agentId,
      catalogEntryId: input.catalogEntryId,
      envJson: input.envJson,
      toolScopesGranted: input.toolScopesGranted,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: input.createdBy,
    };
  };
  delete = async (_: string, _id: string) => true;
  countByCatalogEntry = async (_: string) => 0;
}

describe("AttachmentService.attach", () => {
  let attachments: FakeAttachments;
  let svc: AttachmentService;

  beforeEach(() => {
    attachments = new FakeAttachments();
    svc = new AttachmentService(attachments, new FakeCatalog());
  });

  it("attaches with valid env values and grants all scopes by default", async () => {
    const a = await svc.attach({
      agentId: "agent-1",
      workspaceId: "ws-1",
      catalogEntryId: "entry-1",
      envJson: {
        LINEAR_API_KEY: { kind: "secret", ref: "MY_LINEAR_KEY" },
        LINEAR_TEAM_ID: { kind: "value", value: "ENG" },
      },
      createdBy: "user-1",
    });
    expect(a.envJson).toEqual({
      LINEAR_API_KEY: { kind: "secret", ref: "MY_LINEAR_KEY" },
      LINEAR_TEAM_ID: { kind: "value", value: "ENG" },
    });
    expect(a.toolScopesGranted.sort()).toEqual(["linear.read", "linear.write"]);
  });

  it("allows omitting non-required env", async () => {
    const a = await svc.attach({
      agentId: "agent-1",
      workspaceId: "ws-1",
      catalogEntryId: "entry-1",
      envJson: {
        LINEAR_API_KEY: { kind: "secret", ref: "MY_LINEAR_KEY" },
      },
      createdBy: null,
    });
    expect("LINEAR_TEAM_ID" in a.envJson).toBe(false);
  });

  it("rejects missing required env", async () => {
    await expect(
      svc.attach({
        agentId: "agent-1",
        workspaceId: "ws-1",
        catalogEntryId: "entry-1",
        envJson: {},
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects kind mismatch (value supplied for secret slot)", async () => {
    await expect(
      svc.attach({
        agentId: "agent-1",
        workspaceId: "ws-1",
        catalogEntryId: "entry-1",
        envJson: {
          LINEAR_API_KEY: { kind: "value", value: "leaked-plaintext" },
        },
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects bad secret ref name", async () => {
    await expect(
      svc.attach({
        agentId: "agent-1",
        workspaceId: "ws-1",
        catalogEntryId: "entry-1",
        envJson: {
          LINEAR_API_KEY: { kind: "secret", ref: "lower-case" },
        },
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects undeclared env keys (typo guard)", async () => {
    await expect(
      svc.attach({
        agentId: "agent-1",
        workspaceId: "ws-1",
        catalogEntryId: "entry-1",
        envJson: {
          LINEAR_API_KEY: { kind: "secret", ref: "X" },
          NOT_IN_MANIFEST: { kind: "value", value: "y" },
        },
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when catalog entry is in a different workspace", async () => {
    await expect(
      svc.attach({
        agentId: "agent-1",
        workspaceId: "different-ws",
        catalogEntryId: "entry-1",
        envJson: { LINEAR_API_KEY: { kind: "secret", ref: "X" } },
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
