import { describe, it, expect } from "bun:test";
import type {
  SessionId,
  SessionRepository,
  Session,
} from "@x1agent/domain-sessions";
import { resumeChainSessionIds } from "./resume-chain";

function makeSession(id: string, resumedFrom: string | null): Session {
  return {
    id: id as unknown as SessionId,
    agentId: "agent-1" as never,
    triggeredBy: "human",
    triggeredByUserId: null,
    parentSessionId: null,
    parentAgentId: null,
    resumedFromSessionId: resumedFrom as unknown as SessionId | null,
    triggeredAt: new Date(),
    status: "running",
    completedAt: null,
    errorMessage: null,
    createdAt: new Date(),
    summary: null,
    summaryUpdatedAt: null,
    summaryEventSeq: null,
    modelOverride: null,
  } as unknown as Session;
}

function repoFor(sessions: Session[]): SessionRepository {
  const byId = new Map(sessions.map((s) => [String(s.id), s]));
  return {
    findById: async (id: SessionId) => byId.get(String(id)) ?? null,
  } as unknown as SessionRepository;
}

describe("resumeChainSessionIds", () => {
  it("returns just the session id when there's no resume ancestor", async () => {
    const repo = repoFor([makeSession("A", null)]);
    const chain = await resumeChainSessionIds(repo, "A" as unknown as SessionId);
    expect(chain).toEqual(["A"]);
  });

  it("walks one level of resume", async () => {
    const repo = repoFor([
      makeSession("A", null),
      makeSession("B", "A"),
    ]);
    const chain = await resumeChainSessionIds(repo, "B" as unknown as SessionId);
    expect(chain).toEqual(["B", "A"]);
  });

  it("walks multi-level resume chains", async () => {
    const repo = repoFor([
      makeSession("A", null),
      makeSession("B", "A"),
      makeSession("C", "B"),
      makeSession("D", "C"),
    ]);
    const chain = await resumeChainSessionIds(repo, "D" as unknown as SessionId);
    expect(chain).toEqual(["D", "C", "B", "A"]);
  });

  it("includes a foreign session only when it's actually on the chain", async () => {
    const repo = repoFor([
      makeSession("A", null),
      makeSession("B", "A"),
      makeSession("X", null), // different chain entirely
    ]);
    const chain = await resumeChainSessionIds(repo, "B" as unknown as SessionId);
    expect(chain).not.toContain("X");
  });

  it("terminates safely on a cycle (defense; cycles shouldn't be writable)", async () => {
    const repo = repoFor([
      makeSession("A", "B"),
      makeSession("B", "A"),
    ]);
    const chain = await resumeChainSessionIds(repo, "A" as unknown as SessionId);
    expect(chain.length).toBeLessThanOrEqual(2);
    expect(new Set(chain)).toEqual(new Set(["A", "B"]));
  });

  it("respects maxDepth as a guard against pathological chains", async () => {
    const sessions: Session[] = [];
    for (let i = 0; i < 20; i++) {
      sessions.push(makeSession(`s${i}`, i === 0 ? null : `s${i - 1}`));
    }
    const repo = repoFor(sessions);
    const chain = await resumeChainSessionIds(
      repo,
      "s19" as unknown as SessionId,
      5,
    );
    expect(chain.length).toBe(5);
    expect(chain[0]).toBe("s19");
  });
});
