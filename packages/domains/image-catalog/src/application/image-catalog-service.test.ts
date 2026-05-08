import { describe, it, expect, beforeEach } from "bun:test";
import { ImageCatalogService } from "./image-catalog-service.js";
import { ImageName } from "../domain/image-name.js";
import {
  CannotMutatePresetError,
  ImageInUseError,
  ImageNameTakenError,
  ImageNotFoundError,
} from "../domain/errors.js";
import type { AgentImage } from "../domain/agent-image.js";
import type { DockerfileSource } from "../domain/dockerfile-source.js";
import type {
  AgentImageRepository,
  CreateImageInput,
  UpdateImageInput,
} from "../ports/agent-image-repository.js";
import type { BuildQueue } from "../ports/build-queue.js";
import type { AgentImageUsageReader } from "../ports/agent-image-usage-reader.js";

const WS_A = "00000000-0000-0000-0000-00000000000a";
const WS_B = "00000000-0000-0000-0000-00000000000b";
const VALID_DOCKERFILE = "FROM scratch\nRUN true\n";

function makeImage(overrides: Partial<AgentImage> = {}): AgentImage {
  return {
    id: "img-1",
    workspaceId: WS_A,
    name: ImageName("django"),
    displayName: "Django",
    description: null,
    builtRef: "",
    isPreset: false,
    dockerfileSource: VALID_DOCKERFILE as unknown as DockerfileSource,
    buildStatus: "succeeded",
    buildLog: "",
    lastBuiltAt: new Date("2024-01-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

class FakeRepo implements AgentImageRepository {
  rows: AgentImage[] = [];
  list(workspaceId: string): Promise<AgentImage[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.isPreset || r.workspaceId === workspaceId,
      ),
    );
  }
  getVisible(workspaceId: string, id: string): Promise<AgentImage | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve(null);
    if (row.isPreset || row.workspaceId === workspaceId) {
      return Promise.resolve(row);
    }
    return Promise.resolve(null);
  }
  findByName(workspaceId: string, name: string): Promise<AgentImage | null> {
    return Promise.resolve(
      this.rows.find(
        (r) =>
          r.workspaceId === workspaceId &&
          (r.name as unknown as string) === (name as unknown as string),
      ) ?? null,
    );
  }
  create(input: CreateImageInput): Promise<AgentImage> {
    const row = makeImage({
      id: `img-${this.rows.length + 1}`,
      workspaceId: input.workspaceId,
      name: input.name,
      displayName: input.displayName,
      description: input.description,
      dockerfileSource: input.dockerfileSource,
      builtRef: input.builtRef,
      buildStatus: input.buildStatus,
      isPreset: false,
    });
    this.rows.push(row);
    return Promise.resolve(row);
  }
  update(input: UpdateImageInput): Promise<AgentImage | null> {
    const idx = this.rows.findIndex(
      (r) =>
        r.id === input.id &&
        r.workspaceId === input.workspaceId &&
        !r.isPreset,
    );
    if (idx === -1) return Promise.resolve(null);
    const cur = this.rows[idx]!;
    const next: AgentImage = {
      ...cur,
      displayName: input.displayName ?? cur.displayName,
      description:
        input.description === undefined ? cur.description : input.description,
      dockerfileSource: input.dockerfileSource ?? cur.dockerfileSource,
      buildStatus: input.buildStatus ?? cur.buildStatus,
      builtRef: input.builtRef ?? cur.builtRef,
      buildLog: input.buildLog ?? cur.buildLog,
      lastBuiltAt: input.lastBuiltAt ?? cur.lastBuiltAt,
      updatedAt: new Date(),
    };
    this.rows[idx] = next;
    return Promise.resolve(next);
  }
  delete(workspaceId: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.id === id && r.workspaceId === workspaceId && !r.isPreset),
    );
    return Promise.resolve(this.rows.length < before);
  }
}

class FakeQueue implements BuildQueue {
  enqueued: { imageId: string; workspaceId: string }[] = [];
  enqueue(input: { imageId: string; workspaceId: string }): Promise<void> {
    this.enqueued.push(input);
    return Promise.resolve();
  }
}

class FakeUsage implements AgentImageUsageReader {
  using: Record<string, string[]> = {};
  agentSlugsUsingImage(_ws: string, id: string): Promise<string[]> {
    return Promise.resolve(this.using[id] ?? []);
  }
}

describe("ImageCatalogService", () => {
  let repo: FakeRepo;
  let queue: FakeQueue;
  let usage: FakeUsage;
  let svc: ImageCatalogService;

  beforeEach(() => {
    repo = new FakeRepo();
    queue = new FakeQueue();
    usage = new FakeUsage();
    svc = new ImageCatalogService(repo, queue, usage);
  });

  describe("create", () => {
    it("inserts row at status=pending and enqueues a build", async () => {
      const img = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      expect(img.buildStatus).toBe("pending");
      expect(img.workspaceId).toBe(WS_A);
      expect(queue.enqueued).toEqual([
        { imageId: img.id, workspaceId: WS_A },
      ]);
    });

    it("rejects duplicate name in same workspace", async () => {
      await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      await expect(
        svc.create({
          workspaceId: WS_A,
          name: "django",
          displayName: "Django 2",
          dockerfileSource: VALID_DOCKERFILE,
        }),
      ).rejects.toBeInstanceOf(ImageNameTakenError);
    });

    it("allows the same name across workspaces", async () => {
      await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      await expect(
        svc.create({
          workspaceId: WS_B,
          name: "django",
          displayName: "Django",
          dockerfileSource: VALID_DOCKERFILE,
        }),
      ).resolves.toBeDefined();
    });

    it("rejects invalid Dockerfile", async () => {
      await expect(
        svc.create({
          workspaceId: WS_A,
          name: "bad",
          displayName: "Bad",
          dockerfileSource: "RUN echo no-FROM",
        }),
      ).rejects.toThrow();
    });
  });

  describe("update", () => {
    it("queues a rebuild when Dockerfile changes", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      queue.enqueued = [];
      const updated = await svc.update({
        workspaceId: WS_A,
        id: created.id,
        dockerfileSource: "FROM scratch\nRUN echo changed\n",
      });
      expect(updated.buildStatus).toBe("pending");
      expect(queue.enqueued).toHaveLength(1);
    });

    it("does not queue when Dockerfile is byte-identical", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      queue.enqueued = [];
      await svc.update({
        workspaceId: WS_A,
        id: created.id,
        dockerfileSource: VALID_DOCKERFILE,
      });
      expect(queue.enqueued).toHaveLength(0);
    });

    it("refuses to mutate a preset", async () => {
      repo.rows.push(
        makeImage({
          id: "preset-1",
          workspaceId: null,
          isPreset: true,
          buildStatus: "ready",
        }),
      );
      await expect(
        svc.update({
          workspaceId: WS_A,
          id: "preset-1",
          dockerfileSource: VALID_DOCKERFILE,
        }),
      ).rejects.toBeInstanceOf(CannotMutatePresetError);
    });

    it("refuses cross-tenant mutate", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      // Workspace B tries to update workspace A's image.
      await expect(
        svc.update({
          workspaceId: WS_B,
          id: created.id,
          dockerfileSource: "FROM scratch\nRUN echo b\n",
        }),
      ).rejects.toBeInstanceOf(ImageNotFoundError);
    });
  });

  describe("requestRebuild", () => {
    it("queues a build and resets log/status", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      // Pretend the previous build failed.
      await repo.update({
        workspaceId: WS_A,
        id: created.id,
        buildStatus: "failed",
        buildLog: "some log",
      });
      queue.enqueued = [];
      const rebuilt = await svc.requestRebuild(WS_A, created.id);
      expect(rebuilt.buildStatus).toBe("pending");
      expect(rebuilt.buildLog).toBe("");
      expect(queue.enqueued).toHaveLength(1);
    });

    it("is a no-op when already in flight", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      queue.enqueued = [];
      // It's at pending right after create.
      await svc.requestRebuild(WS_A, created.id);
      expect(queue.enqueued).toHaveLength(0);
    });
  });

  describe("delete", () => {
    it("refuses if any agent uses the image", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      usage.using[created.id] = ["agent-foo"];
      await expect(svc.delete(WS_A, created.id)).rejects.toBeInstanceOf(
        ImageInUseError,
      );
    });

    it("deletes when nothing references the image", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      await svc.delete(WS_A, created.id);
      expect(repo.rows).toHaveLength(0);
    });

    it("refuses to delete a preset", async () => {
      repo.rows.push(
        makeImage({
          id: "preset-1",
          workspaceId: null,
          isPreset: true,
          buildStatus: "ready",
        }),
      );
      await expect(svc.delete(WS_A, "preset-1")).rejects.toBeInstanceOf(
        CannotMutatePresetError,
      );
    });

    it("refuses cross-tenant delete", async () => {
      const created = await svc.create({
        workspaceId: WS_A,
        name: "django",
        displayName: "Django",
        dockerfileSource: VALID_DOCKERFILE,
      });
      await expect(svc.delete(WS_B, created.id)).rejects.toBeInstanceOf(
        ImageNotFoundError,
      );
    });
  });
});
