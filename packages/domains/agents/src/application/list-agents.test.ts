import { describe, expect, it } from "bun:test";
import { UserId, WorkspaceId, WorkspaceSlug } from "@x1agent/kernel";
import { InMemoryAgentRepository } from "./fakes.js";
import { listAgents } from "./list-agents.js";

const workspaceId = WorkspaceId("00000000-0000-7000-8000-000000000001");
const owner = UserId("00000000-0000-7000-8000-000000000002");
const viewer = UserId("00000000-0000-7000-8000-000000000003");

describe("listAgents", () => {
  it("does not return a private agent owned by another user", async () => {
    const agents = new InMemoryAgentRepository();
    await agents.create({
      workspaceId,
      slug: WorkspaceSlug("private-agent"),
      name: "Private agent",
      runtimeType: "claude_code",
      systemPrompt: "",
      heartbeatMd: "",
      schedule: null,
      visibility: "private",
      createdBy: owner,
    });
    await agents.create({
      workspaceId,
      slug: WorkspaceSlug("workspace-agent"),
      name: "Workspace agent",
      runtimeType: "claude_code",
      systemPrompt: "",
      heartbeatMd: "",
      schedule: null,
      visibility: "workspace",
      createdBy: owner,
    });

    const visible = await listAgents(agents, viewer, workspaceId);

    expect(visible.map((agent) => String(agent.slug))).toEqual(["workspace-agent"]);
  });
});
