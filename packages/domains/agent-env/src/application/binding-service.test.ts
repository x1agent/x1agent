import { describe, it, expect, beforeEach } from "bun:test";
import { BindingService } from "./binding-service.js";
import type { EnvName } from "../domain/env-name.js";
import type {
  BindingRepository,
  BindingUpsertInput,
} from "../ports/binding-repository.js";
import { ValidationError } from "@x1agent/kernel";
import type { AgentEnvBinding } from "../domain/binding.js";

class FakeRepo implements BindingRepository {
  saved: BindingUpsertInput | null = null;
  bindings: AgentEnvBinding[] = [];
  listByAgent = async (_: string) => this.bindings;
  upsert = async (input: BindingUpsertInput) => {
    this.saved = input;
    return {
      id: "b-1",
      agentId: input.agentId,
      envName: input.envName,
      secretName: input.secretName,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: input.createdBy,
    };
  };
  delete = async (_: string, _e: EnvName) => true;
  agentHasAny = async (_: string) => this.bindings.length > 0;
}

describe("BindingService.set", () => {
  let repo: FakeRepo;

  beforeEach(() => {
    repo = new FakeRepo();
  });

  it("binds when the secret exists", async () => {
    const svc = new BindingService(repo, async () => true);
    const b = await svc.set({
      agentId: "a-1",
      workspaceId: "ws-1",
      envName: "ANTHROPIC_API_KEY",
      secretName: "MY_ANTHROPIC_KEY",
      createdBy: "u-1",
    });
    expect(b.envName as unknown as string).toBe("ANTHROPIC_API_KEY");
    expect(b.secretName).toBe("MY_ANTHROPIC_KEY");
  });

  it("rejects non-existent secret", async () => {
    const svc = new BindingService(repo, async () => false);
    await expect(
      svc.set({
        agentId: "a-1",
        workspaceId: "ws-1",
        envName: "X",
        secretName: "MISSING",
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects bad env name", async () => {
    const svc = new BindingService(repo, async () => true);
    await expect(
      svc.set({
        agentId: "a-1",
        workspaceId: "ws-1",
        envName: "lower",
        secretName: "X",
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects bad secret name", async () => {
    const svc = new BindingService(repo, async () => true);
    await expect(
      svc.set({
        agentId: "a-1",
        workspaceId: "ws-1",
        envName: "X",
        secretName: "lower-case",
        createdBy: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
