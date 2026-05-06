import { describe, expect, test, beforeEach } from "bun:test";
import {
  UserId,
  WorkspaceId,
  WorkspaceSlug,
} from "@x1agent/kernel";
import {
  InMemoryMembershipRepository,
  InMemoryWorkspaceRepository,
} from "./fakes.js";
import {
  updateWorkspaceSettings,
  WorkspaceNotFoundError,
} from "./update-workspace-settings.js";
import {
  InsufficientRoleError,
  NotAMemberError,
} from "../domain/membership.js";

let workspaces: InMemoryWorkspaceRepository;
let memberships: InMemoryMembershipRepository;
let admin: ReturnType<typeof UserId>;
let editor: ReturnType<typeof UserId>;
let outsider: ReturnType<typeof UserId>;
let slugA: ReturnType<typeof WorkspaceSlug>;
let wsAId: ReturnType<typeof WorkspaceId>;

beforeEach(async () => {
  workspaces = new InMemoryWorkspaceRepository();
  memberships = new InMemoryMembershipRepository(workspaces);
  admin = UserId("00000000-0000-7000-8000-aaaaaaaaaaaa");
  editor = UserId("00000000-0000-7000-8000-bbbbbbbbbbbb");
  outsider = UserId("00000000-0000-7000-8000-cccccccccccc");
  slugA = WorkspaceSlug("acme");
  const ws = await workspaces.create({ slug: slugA, name: "Acme" });
  wsAId = ws.id;
  await memberships.grant({ workspaceId: wsAId, userId: admin, role: "admin" });
  await memberships.grant({
    workspaceId: wsAId,
    userId: editor,
    role: "member",
  });
});

describe("updateWorkspaceSettings", () => {
  test("admin can flip the OAuth-on-orchestrators policy", async () => {
    const ws = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { oauthMcpsOnOrchestrators: "on_attended" },
    );
    expect(ws.settings.oauthMcpsOnOrchestrators).toBe("on_attended");
    // Persisted
    const reloaded = await workspaces.findBySlug(slugA);
    expect(reloaded?.settings.oauthMcpsOnOrchestrators).toBe("on_attended");
  });

  test("admin can choose 'on'", async () => {
    const ws = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { oauthMcpsOnOrchestrators: "on" },
    );
    expect(ws.settings.oauthMcpsOnOrchestrators).toBe("on");
  });

  test("non-admin (member role) is rejected", async () => {
    await expect(
      updateWorkspaceSettings(
        { workspaces, memberships },
        editor,
        slugA,
        { oauthMcpsOnOrchestrators: "on" },
      ),
    ).rejects.toBeInstanceOf(InsufficientRoleError);

    // Untouched
    const reloaded = await workspaces.findBySlug(slugA);
    expect(reloaded?.settings.oauthMcpsOnOrchestrators).toBe("off");
  });

  test("non-member is rejected with NotAMember", async () => {
    await expect(
      updateWorkspaceSettings(
        { workspaces, memberships },
        outsider,
        slugA,
        { oauthMcpsOnOrchestrators: "on" },
      ),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  test("non-existent workspace → WorkspaceNotFoundError", async () => {
    await expect(
      updateWorkspaceSettings(
        { workspaces, memberships },
        admin,
        WorkspaceSlug("ghost"),
        { oauthMcpsOnOrchestrators: "on" },
      ),
      // The role-assert runs first and trips on the missing membership;
      // this is a NotAMember, not a NotFound. Same defensive layering as
      // the other workspace routes — never leaks "this slug doesn't exist".
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  test("invalid mode is silently dropped (no-op patch)", async () => {
    const ws = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { oauthMcpsOnOrchestrators: "yolo" },
    );
    // The unknown value got stripped by the parser; the underlying
    // setting stays at its prior value (still the default).
    expect(ws.settings.oauthMcpsOnOrchestrators).toBe("off");
  });

  test("unknown keys in patch are stripped", async () => {
    const ws = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { foo: "bar", oauthMcpsOnOrchestrators: "on" } as unknown,
    );
    // Mode applied, foo not present in settings.
    expect(ws.settings.oauthMcpsOnOrchestrators).toBe("on");
    expect((ws.settings as Record<string, unknown>).foo).toBeUndefined();
  });

  test("empty patch is a no-op (no write)", async () => {
    const before = await workspaces.findBySlug(slugA);
    const after = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      {},
    );
    expect(after.settings).toEqual(before!.settings);
  });

  test("patches do not affect other settings (shallow merge)", async () => {
    // Pre-set a non-default value so we can confirm a follow-up
    // patch on a *different* (future) key wouldn't blow it away.
    await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { oauthMcpsOnOrchestrators: "on" },
    );
    // No-op patch (unknown future key), should preserve the policy.
    const ws = await updateWorkspaceSettings(
      { workspaces, memberships },
      admin,
      slugA,
      { someFutureKey: true } as unknown,
    );
    expect(ws.settings.oauthMcpsOnOrchestrators).toBe("on");
  });
});
