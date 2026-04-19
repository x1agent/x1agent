import { describe, expect, it, beforeEach } from "bun:test";
import {
  DomainError,
  UserId,
  ValidationError,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import { AgentId } from "@x1agent/domain-agents";
import {
  CollectionId,
  CollectionProviderType,
  CollectionSlug,
  buildBackendHandle,
} from "../domain/collection.js";
import { createCollection } from "./create-collection.js";
import { deleteCollection } from "./delete-collection.js";
import { updateCollection } from "./update-collection.js";
import { listCollections } from "./list-collections.js";
import { syncAgentAttachments } from "./sync-agent-attachments.js";
import {
  AllowAllAdmin,
  DenyAdmin,
  InMemoryCollectionRepository,
  RecordingProviderGateway,
} from "./fakes.js";

const ws = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e000");
const otherWs = WorkspaceId("019da258-70a0-7efa-98a1-47cdc5f9e999");
const actor = UserId("019da258-70a3-7ea0-b83e-6b12c465e7c9");
const agent = AgentId("019da258-70a0-7efa-98a1-47cdc5f9ea11");
const workspaceSlug = WorkspaceSlug("default");

let collections: InMemoryCollectionRepository;
let providers: RecordingProviderGateway;

beforeEach(() => {
  collections = new InMemoryCollectionRepository();
  providers = new RecordingProviderGateway();
});

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    throw new Error(`expected ${code}`);
  } catch (err) {
    if (!(err instanceof DomainError))
      throw new Error(`expected DomainError, got ${String(err)}`);
    expect(err.code).toBe(code);
  }
}

describe("domain validators", () => {
  it.each(["general", "code-notes", "x-1"])("CollectionSlug accepts %p", (s) => {
    expect(CollectionSlug(s)).toBe(s as never);
  });
  it.each(["", "UPPER", "with_underscore", "-lead", "trailing-"])(
    "CollectionSlug rejects %p",
    (s) => {
      expect(() => CollectionSlug(s)).toThrow(ValidationError);
    },
  );

  it("CollectionProviderType accepts known", () => {
    expect(CollectionProviderType("surrealdb")).toBe("surrealdb" as never);
  });
  it("CollectionProviderType rejects unknown", () => {
    expect(() => CollectionProviderType("cosmosdb")).toThrow(ValidationError);
  });

  it("buildBackendHandle uses underscores", () => {
    expect(
      buildBackendHandle(WorkspaceSlug("main-team"), CollectionSlug("code-notes")),
    ).toBe("col_main_team_code_notes");
  });
});

describe("createCollection", () => {
  it("inserts a row and calls the provider gateway", async () => {
    const c = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "General",
        slug: CollectionSlug("general"),
        description: "Catch-all",
        providerType: "surrealdb",
        settings: {},
      },
    );
    expect(c.backendHandle).toBe("col_default_general" as never);
    expect(collections.rows).toHaveLength(1);
    expect(providers.calls).toHaveLength(1);
    expect(providers.calls[0]).toMatchObject({
      kind: "provision",
      providerType: "surrealdb",
      handle: "col_default_general",
    });
  });

  it("rejects duplicate slug in the same workspace", async () => {
    await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "General",
        slug: CollectionSlug("general"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    await expectCode(
      createCollection(
        { collections, adminGuard: new AllowAllAdmin(), providers },
        {
          actor,
          workspaceId: ws,
          workspaceSlug,
          name: "General Two",
          slug: CollectionSlug("general"),
          description: null,
          providerType: "surrealdb",
          settings: {},
        },
      ),
      "collection_slug_taken",
    );
  });

  it("allows the same slug in a different workspace", async () => {
    await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "General",
        slug: CollectionSlug("general"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    const other = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: otherWs,
        workspaceSlug: WorkspaceSlug("other"),
        name: "General",
        slug: CollectionSlug("general"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    expect(other.backendHandle).toBe("col_other_general" as never);
  });

  it("rejects non-admin", async () => {
    await expectCode(
      createCollection(
        { collections, adminGuard: new DenyAdmin(), providers },
        {
          actor,
          workspaceId: ws,
          workspaceSlug,
          name: "Nope",
          slug: CollectionSlug("nope"),
          description: null,
          providerType: "surrealdb",
          settings: {},
        },
      ),
      "admin_denied",
    );
    expect(collections.rows).toHaveLength(0);
    expect(providers.calls).toHaveLength(0);
  });
});

describe("deleteCollection", () => {
  it("calls deprovision then removes the row", async () => {
    const c = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "X",
        slug: CollectionSlug("x"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    providers.calls.length = 0;
    await deleteCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      { actor, workspaceId: ws, collectionId: c.id },
    );
    expect(providers.calls[0]?.kind).toBe("deprovision");
    expect(collections.rows).toHaveLength(0);
  });

  it("rejects cross-workspace delete", async () => {
    const c = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "X",
        slug: CollectionSlug("x"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    await expectCode(
      deleteCollection(
        { collections, adminGuard: new AllowAllAdmin(), providers },
        { actor, workspaceId: otherWs, collectionId: c.id },
      ),
      "collection_wrong_workspace",
    );
  });
});

describe("updateCollection", () => {
  it("patches name + description", async () => {
    const c = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "Original",
        slug: CollectionSlug("orig"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    const next = await updateCollection(
      { collections, adminGuard: new AllowAllAdmin() },
      {
        actor,
        workspaceId: ws,
        collectionId: c.id,
        patch: { name: "Renamed", description: "now with a description" },
      },
    );
    expect(next.name).toBe("Renamed");
    expect(next.description).toBe("now with a description");
  });
});

describe("listCollections", () => {
  it("returns only the workspace's collections", async () => {
    await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "A",
        slug: CollectionSlug("a"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: otherWs,
        workspaceSlug: WorkspaceSlug("other"),
        name: "B",
        slug: CollectionSlug("b"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    const rows = await listCollections({ collections }, actor, ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("a" as never);
  });
});

describe("syncAgentAttachments", () => {
  async function seedTwoCollections() {
    const a = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "A",
        slug: CollectionSlug("a"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    const b = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: ws,
        workspaceSlug,
        name: "B",
        slug: CollectionSlug("b"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    return { a, b };
  }

  it("attaches both, marks one as default", async () => {
    const { a, b } = await seedTwoCollections();
    await syncAgentAttachments(
      { collections, adminGuard: new AllowAllAdmin() },
      {
        actor,
        workspaceId: ws,
        agentId: agent,
        collectionIds: [a.id, b.id],
        defaultCollectionId: a.id,
      },
    );
    const attached = await collections.listCollectionsForAgent(agent);
    expect([...attached.map((c) => String(c.slug))].sort()).toEqual([
      "a",
      "b",
    ]);
    expect(attached.find((c) => String(c.slug) === "a")?.isDefault).toBe(true);
    expect(attached.find((c) => String(c.slug) === "b")?.isDefault).toBe(false);
  });

  it("replaces the set when called again", async () => {
    const { a, b } = await seedTwoCollections();
    await syncAgentAttachments(
      { collections, adminGuard: new AllowAllAdmin() },
      {
        actor,
        workspaceId: ws,
        agentId: agent,
        collectionIds: [a.id],
        defaultCollectionId: a.id,
      },
    );
    await syncAgentAttachments(
      { collections, adminGuard: new AllowAllAdmin() },
      {
        actor,
        workspaceId: ws,
        agentId: agent,
        collectionIds: [b.id],
        defaultCollectionId: b.id,
      },
    );
    const attached = await collections.listCollectionsForAgent(agent);
    expect(attached.map((c) => String(c.slug))).toEqual(["b"]);
  });

  it("rejects default not in the set", async () => {
    const { a, b } = await seedTwoCollections();
    await expectCode(
      syncAgentAttachments(
        { collections, adminGuard: new AllowAllAdmin() },
        {
          actor,
          workspaceId: ws,
          agentId: agent,
          collectionIds: [a.id],
          defaultCollectionId: b.id,
        },
      ),
      "default_not_in_attachment_set",
    );
  });

  it("rejects cross-workspace ids", async () => {
    // seed a collection in the *other* workspace
    const other = await createCollection(
      { collections, adminGuard: new AllowAllAdmin(), providers },
      {
        actor,
        workspaceId: otherWs,
        workspaceSlug: WorkspaceSlug("other"),
        name: "Other",
        slug: CollectionSlug("other"),
        description: null,
        providerType: "surrealdb",
        settings: {},
      },
    );
    await expectCode(
      syncAgentAttachments(
        { collections, adminGuard: new AllowAllAdmin() },
        {
          actor,
          workspaceId: ws,
          agentId: agent,
          collectionIds: [other.id],
          defaultCollectionId: null,
        },
      ),
      "collection_not_found",
    );
  });

  it("rejects unknown collection id", async () => {
    await expectCode(
      syncAgentAttachments(
        { collections, adminGuard: new AllowAllAdmin() },
        {
          actor,
          workspaceId: ws,
          agentId: agent,
          collectionIds: [CollectionId("00000000-0000-0000-0000-000000000000")],
          defaultCollectionId: null,
        },
      ),
      "collection_not_found",
    );
  });
});
