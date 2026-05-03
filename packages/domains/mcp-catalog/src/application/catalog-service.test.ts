import { describe, it, expect, beforeEach } from "bun:test";
import { CatalogService } from "./catalog-service.js";
import type { CatalogEntry } from "../domain/catalog-entry.js";
import type { CatalogName } from "../domain/catalog-name.js";
import type {
  CatalogRepository,
  CatalogUpsertInput,
} from "../ports/catalog-repository.js";
import { ValidationError } from "@x1agent/kernel";

class FakeRepo implements CatalogRepository {
  saved: CatalogUpsertInput | null = null;
  list = async (_: string) => [];
  getById = async (_: string, _id: string) => null;
  getByName = async (_: string, _n: CatalogName) => null;
  upsert = async (input: CatalogUpsertInput): Promise<CatalogEntry> => {
    this.saved = input;
    return {
      id: "e-1",
      workspaceId: input.workspaceId,
      name: input.name,
      displayName: input.displayName,
      image: input.image,
      command: input.command,
      args: input.args,
      manifest: input.manifest,
      description: input.description,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: input.createdBy,
    };
  };
  delete = async (_: string, _id: string) => true;
}

const validManifest = { env: {}, tool_scopes: {} };

describe("CatalogService.set — image vs command", () => {
  let repo: FakeRepo;
  let svc: CatalogService;

  beforeEach(() => {
    repo = new FakeRepo();
    svc = new CatalogService(repo);
  });

  it("accepts image-only entry", async () => {
    const e = await svc.set({
      workspaceId: "ws-1",
      name: "linear",
      image: "ghcr.io/org/linear-mcp:1.2.0",
      manifest: validManifest,
      createdBy: null,
    });
    expect(e.image).toBe("ghcr.io/org/linear-mcp:1.2.0");
    expect(e.command).toBeNull();
    expect(e.args).toEqual([]);
  });

  it("accepts command-only entry with args", async () => {
    const e = await svc.set({
      workspaceId: "ws-1",
      name: "mercury",
      command: "npx",
      args: ["-y", "@author/mercury-mcp"],
      manifest: validManifest,
      createdBy: null,
    });
    expect(e.image).toBeNull();
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "@author/mercury-mcp"]);
  });

  it("rejects setting both image and command", async () => {
    await expect(
      svc.set({
        workspaceId: "ws-1",
        name: "both",
        image: "ghcr.io/x/y:1",
        command: "npx",
        manifest: validManifest,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects neither image nor command", async () => {
    await expect(
      svc.set({
        workspaceId: "ws-1",
        name: "neither",
        manifest: validManifest,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects bad command (shell metacharacters)", async () => {
    await expect(
      svc.set({
        workspaceId: "ws-1",
        name: "bad",
        command: "npx; rm -rf /",
        manifest: validManifest,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects non-string args", async () => {
    await expect(
      svc.set({
        workspaceId: "ws-1",
        name: "bad-args",
        command: "npx",
        args: ["-y", 42 as unknown as string],
        manifest: validManifest,
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
