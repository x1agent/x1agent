import { describe, expect, it } from "bun:test";
import { UserId, WorkspaceSlug } from "@x1agent/kernel";
import {
  InMemoryMembershipRepository,
  InMemoryWorkspaceRepository,
} from "@x1agent/domain-workspaces";
import {
  listAdministrativeMcpWorkspaces,
  resolveAdministrativeMcpWorkspaceAccess,
} from "./workspace-access.js";

const user = UserId("00000000-0000-7000-8000-000000000001");

describe("administrative MCP workspace access", () => {
  it("requires both installation and live workspace opt-in", async () => {
    const workspaces = new InMemoryWorkspaceRepository();
    const memberships = new InMemoryMembershipRepository(workspaces);
    const workspace = await workspaces.create({ slug: WorkspaceSlug("alpha"), name: "Alpha" });
    await memberships.grant({ workspaceId: workspace.id, userId: user, role: "admin" });
    const gate = { isEnabled: async () => true };

    expect(
      await resolveAdministrativeMcpWorkspaceAccess(
        { installationGate: gate, workspaces, memberships }, user, workspace.id,
      ),
    ).toEqual({ allowed: false, reason: "workspace_mcp_disabled" });

    await workspaces.updateSettings(workspace.id, { administrativeMcpEnabled: true });
    expect(
      await resolveAdministrativeMcpWorkspaceAccess(
        { installationGate: gate, workspaces, memberships }, user, workspace.id,
      ),
    ).toEqual({ allowed: true, workspaceId: workspace.id, role: "admin" });
  });

  it("drops a workspace immediately when membership is revoked", async () => {
    const workspaces = new InMemoryWorkspaceRepository();
    const memberships = new InMemoryMembershipRepository(workspaces);
    const workspace = await workspaces.create({ slug: WorkspaceSlug("alpha"), name: "Alpha" });
    await workspaces.updateSettings(workspace.id, { administrativeMcpEnabled: true });
    await memberships.grant({ workspaceId: workspace.id, userId: user, role: "member" });
    const deps = { installationGate: { isEnabled: async () => true }, workspaces, memberships };

    expect(await listAdministrativeMcpWorkspaces(deps, user)).toHaveLength(1);
    await memberships.revoke(user, workspace.id);
    expect(await listAdministrativeMcpWorkspaces(deps, user)).toEqual([]);
  });
});
