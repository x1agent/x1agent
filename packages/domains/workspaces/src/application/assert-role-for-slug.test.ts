import { describe, it, expect, beforeEach } from "bun:test";
import { Role, UserId, WorkspaceSlug } from "@x1agent/kernel";
import {
  InMemoryMembershipRepository,
  InMemoryWorkspaceRepository,
} from "./fakes.js";
import { assertRoleForSlug } from "./assert-role-for-slug.js";
import {
  InsufficientRoleError,
  NotAMemberError,
} from "../domain/membership.js";

const USER = UserId("0188f5e1-7e3b-7000-8000-000000000001");

let workspaces: InMemoryWorkspaceRepository;
let memberships: InMemoryMembershipRepository;

beforeEach(async () => {
  workspaces = new InMemoryWorkspaceRepository();
  memberships = new InMemoryMembershipRepository(workspaces);
  const w = await workspaces.create({
    slug: WorkspaceSlug("default"),
    name: "Default",
  });
  await memberships.grant({
    workspaceId: w.id,
    userId: USER,
    role: Role("admin"),
  });
});

describe("assertRoleForSlug", () => {
  it("returns the membership when role suffices", async () => {
    const m = await assertRoleForSlug(
      memberships,
      USER,
      WorkspaceSlug("default"),
      Role("admin"),
    );
    expect(m.role).toBe("admin");
  });

  it("throws NotAMemberError when the user is absent", async () => {
    await expect(
      assertRoleForSlug(
        memberships,
        UserId("0188f5e1-7e3b-7000-8000-000000000999"),
        WorkspaceSlug("default"),
        Role("member"),
      ),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it("throws NotAMemberError when the slug doesn't exist", async () => {
    await expect(
      assertRoleForSlug(
        memberships,
        USER,
        WorkspaceSlug("missing"),
        Role("member"),
      ),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it("throws InsufficientRoleError for lower role", async () => {
    await expect(
      assertRoleForSlug(
        memberships,
        USER,
        WorkspaceSlug("default"),
        Role("owner"),
      ),
    ).rejects.toBeInstanceOf(InsufficientRoleError);
  });
});
