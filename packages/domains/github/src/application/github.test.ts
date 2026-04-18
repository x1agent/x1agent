import { describe, it, expect, beforeEach } from "bun:test";
import { UserId } from "@x1agent/kernel";
import { InstallationId } from "../domain/installation.js";
import {
  InstallationNotFoundError,
  InstallationNotOwnedError,
} from "../domain/installation.js";
import {
  RepoInstallationMismatchError,
  RepoNotInInstallationError,
} from "../domain/repo.js";
import { recordInstallation } from "./record-installation.js";
import { attachRepoToAgent } from "./attach-repo-to-agent.js";
import { detachRepoFromAgent } from "./detach-repo-from-agent.js";
import {
  FakeGitHubAppClient,
  InMemoryAgentRepoStore,
  InMemoryInstallationRepository,
} from "./fakes.js";

const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const ALICE = UserId(uuid(1));
const BOB = UserId(uuid(2));
const ALICE_WS = uuid(10);
const ALICE_AGENT = uuid(20);

let installations: InMemoryInstallationRepository;
let agentRepos: InMemoryAgentRepoStore;
let client: FakeGitHubAppClient;

beforeEach(() => {
  installations = new InMemoryInstallationRepository();
  agentRepos = new InMemoryAgentRepoStore();
  client = new FakeGitHubAppClient({
    installs: [
      {
        id: 1001,
        accountLogin: "alice",
        accountType: "User",
        repos: ["alice/proj-one", "alice/proj-two"],
      },
      {
        id: 1002,
        accountLogin: "bob",
        accountType: "User",
        repos: ["bob/elsewhere"],
      },
    ],
  });
  agentRepos.seedAgent(ALICE_AGENT, ALICE_WS, ALICE);
});

describe("recordInstallation", () => {
  it("fetches install details and persists them attached to the user", async () => {
    const inst = await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1001), actor: ALICE },
    );
    expect(inst.installationId).toBe(1001 as ReturnType<typeof InstallationId>);
    expect(inst.accountLogin).toBe("alice");
    expect(inst.installedByUserId).toBe(ALICE);
    const list = await installations.listByUser(ALICE);
    expect(list).toHaveLength(1);
  });

  it("upserts — re-installing the same id updates the installer", async () => {
    await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1001), actor: ALICE },
    );
    await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1001), actor: ALICE },
    );
    expect(installations.rows).toHaveLength(1);
  });
});

describe("attachRepoToAgent", () => {
  async function seed() {
    await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1001), actor: ALICE },
    );
  }

  it("attaches a repo and records the install on the agent", async () => {
    await seed();
    await attachRepoToAgent(
      { client, installations, agentRepos },
      {
        actor: ALICE,
        agentId: ALICE_AGENT,
        installationId: InstallationId(1001),
        repoFullName: "alice/proj-one",
      },
    );
    expect(await agentRepos.getLinkedInstallation(ALICE_AGENT)).toBe(
      1001 as ReturnType<typeof InstallationId>,
    );
    expect(await agentRepos.listRepos(ALICE_AGENT)).toEqual(["alice/proj-one"]);
  });

  it("allows a second repo from the same installation", async () => {
    await seed();
    await attachRepoToAgent(
      { client, installations, agentRepos },
      {
        actor: ALICE,
        agentId: ALICE_AGENT,
        installationId: InstallationId(1001),
        repoFullName: "alice/proj-one",
      },
    );
    await attachRepoToAgent(
      { client, installations, agentRepos },
      {
        actor: ALICE,
        agentId: ALICE_AGENT,
        installationId: InstallationId(1001),
        repoFullName: "alice/proj-two",
      },
    );
    expect(await agentRepos.listRepos(ALICE_AGENT)).toHaveLength(2);
  });

  it("rejects a repo from a different installation once one is linked", async () => {
    await seed();
    await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1002), actor: BOB },
    );
    await attachRepoToAgent(
      { client, installations, agentRepos },
      {
        actor: ALICE,
        agentId: ALICE_AGENT,
        installationId: InstallationId(1001),
        repoFullName: "alice/proj-one",
      },
    );
    await expect(
      attachRepoToAgent(
        { client, installations, agentRepos },
        {
          actor: BOB,
          agentId: ALICE_AGENT,
          installationId: InstallationId(1002),
          repoFullName: "bob/elsewhere",
        },
      ),
    ).rejects.toBeInstanceOf(RepoInstallationMismatchError);
  });

  it("rejects a repo not visible to the installation", async () => {
    await seed();
    await expect(
      attachRepoToAgent(
        { client, installations, agentRepos },
        {
          actor: ALICE,
          agentId: ALICE_AGENT,
          installationId: InstallationId(1001),
          repoFullName: "alice/secret-not-selected",
        },
      ),
    ).rejects.toBeInstanceOf(RepoNotInInstallationError);
  });

  it("rejects attaching using an installation the actor did not install", async () => {
    await seed();
    await expect(
      attachRepoToAgent(
        { client, installations, agentRepos },
        {
          actor: BOB,
          agentId: ALICE_AGENT,
          installationId: InstallationId(1001),
          repoFullName: "alice/proj-one",
        },
      ),
    ).rejects.toBeInstanceOf(InstallationNotOwnedError);
  });

  it("rejects an unknown installation id", async () => {
    await expect(
      attachRepoToAgent(
        { client, installations, agentRepos },
        {
          actor: ALICE,
          agentId: ALICE_AGENT,
          installationId: InstallationId(9999),
          repoFullName: "whatever",
        },
      ),
    ).rejects.toBeInstanceOf(InstallationNotFoundError);
  });
});

describe("detachRepoFromAgent", () => {
  it("removes the repo", async () => {
    await recordInstallation(
      { client, installations },
      { installationId: InstallationId(1001), actor: ALICE },
    );
    await attachRepoToAgent(
      { client, installations, agentRepos },
      {
        actor: ALICE,
        agentId: ALICE_AGENT,
        installationId: InstallationId(1001),
        repoFullName: "alice/proj-one",
      },
    );
    await detachRepoFromAgent(
      { agentRepos },
      { actor: ALICE, agentId: ALICE_AGENT, repoFullName: "alice/proj-one" },
    );
    expect(await agentRepos.listRepos(ALICE_AGENT)).toEqual([]);
  });
});
