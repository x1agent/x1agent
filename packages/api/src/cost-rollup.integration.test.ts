// Real-Postgres regression coverage for PostgresTokenUsageRepository.
//
// The X1A-37 cost-surfacing feature shipped with rollupForAgent referencing
// `sessions.workspace_id`, a column that does not exist (sessions reaches
// workspace via agents). The unit test passed because it used the in-memory
// adapter, which doesn't enforce SQL constraints. Production logged
// `column "workspace_id" does not exist` across four releases (X1A-115)
// before the gap was caught. This file exercises every rollup* method on
// the real Postgres adapter so that class of regression cannot ship again.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  PostgresTokenUsageRepository,
  type AgentCostWindow,
} from "@x1agent/domain-sessions";
import { dropTestDb, freshTestDb } from "./test-helpers.js";

const TEST_DB = "x1agent_cost_rollup_test";

let dbSql: Awaited<ReturnType<typeof freshTestDb>>["sql"];
let repo: PostgresTokenUsageRepository;

let workspaceId: string;
let otherWorkspaceId: string;
let agentId: string;
let otherAgentId: string;
let sessionA: string;
let sessionB: string;
let foreignSession: string;

beforeAll(async () => {
  const db = await freshTestDb(TEST_DB);
  dbSql = db.sql;
  repo = new PostgresTokenUsageRepository(dbSql);

  const [ws] = await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('rollup-ws', 'Rollup WS')
    RETURNING id
  `;
  const [otherWs] = await dbSql<{ id: string }[]>`
    INSERT INTO workspaces (slug, name) VALUES ('rollup-other', 'Other WS')
    RETURNING id
  `;
  workspaceId = ws!.id;
  otherWorkspaceId = otherWs!.id;

  const [agent] = await dbSql<{ id: string }[]>`
    INSERT INTO agents (workspace_id, slug, name, runtime_type)
    VALUES (${workspaceId}, 'roller', 'Roller', 'claude_code')
    RETURNING id
  `;
  const [otherAgent] = await dbSql<{ id: string }[]>`
    INSERT INTO agents (workspace_id, slug, name, runtime_type)
    VALUES (${otherWorkspaceId}, 'foreign', 'Foreign', 'claude_code')
    RETURNING id
  `;
  agentId = agent!.id;
  otherAgentId = otherAgent!.id;

  const [sA] = await dbSql<{ id: string }[]>`
    INSERT INTO sessions (agent_id, triggered_by, triggered_at, status, summary)
    VALUES (${agentId}, 'scheduler', '2026-05-10T00:00:00Z', 'complete',
            'session A summary')
    RETURNING id
  `;
  const [sB] = await dbSql<{ id: string }[]>`
    INSERT INTO sessions (agent_id, triggered_by, triggered_at, status, summary)
    VALUES (${agentId}, 'scheduler', '2026-05-11T00:00:00Z', 'complete',
            'session B summary')
    RETURNING id
  `;
  const [sForeign] = await dbSql<{ id: string }[]>`
    INSERT INTO sessions (agent_id, triggered_by, triggered_at, status, summary)
    VALUES (${otherAgentId}, 'scheduler', '2026-05-11T00:00:00Z', 'complete',
            'foreign session summary')
    RETURNING id
  `;
  sessionA = sA!.id;
  sessionB = sB!.id;
  foreignSession = sForeign!.id;

  // Two turns on session A, one turn on session B — all under our agent.
  await dbSql`
    INSERT INTO token_usage
      (session_id, workspace_id, agent_id, model,
       input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       event_seq, ts)
    VALUES
      (${sessionA}, ${workspaceId}, ${agentId}, 'claude-sonnet-4-5',
       1000, 200, 0, 0, 1, '2026-05-10T00:10:00Z'),
      (${sessionA}, ${workspaceId}, ${agentId}, 'claude-sonnet-4-5',
       500,  100, 0, 0, 2, '2026-05-10T00:20:00Z'),
      (${sessionB}, ${workspaceId}, ${agentId}, 'claude-sonnet-4-5',
       2000, 400, 0, 0, 1, '2026-05-11T00:05:00Z')
  `;

  // A row under a different workspace — must not leak through.
  await dbSql`
    INSERT INTO token_usage
      (session_id, workspace_id, agent_id, model,
       input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens,
       event_seq, ts)
    VALUES
      (${foreignSession}, ${otherWorkspaceId}, ${otherAgentId},
       'claude-sonnet-4-5', 9000, 9000, 0, 0, 1, '2026-05-11T00:00:00Z')
  `;
});

afterAll(async () => {
  if (dbSql) await dbSql.end();
  await dropTestDb(TEST_DB);
});

describe("PostgresTokenUsageRepository.rollupForAgent (X1A-115 regression)", () => {
  it('does not throw "column workspace_id does not exist" on real Postgres', async () => {
    // The "all" window is the simplest path through rollupForAgent and
    // still hits every join the failing release did. If the query
    // references a nonexistent column, this call throws — guarding the
    // exact production failure mode.
    const result = await repo.rollupForAgent({
      agentId,
      workspaceId,
      window: "all" as AgentCostWindow,
      now: new Date("2026-05-13T00:00:00Z"),
    });

    expect(result.agentId).toBe(agentId);
    expect(result.totals.inputTokens).toBe(3500);
    expect(result.totals.outputTokens).toBe(700);
    expect(result.topSessions).toHaveLength(2);

    // Top-session metadata must be populated from the sessions table —
    // started_at + summary come from the join that previously failed.
    const sessions = new Map(result.topSessions.map((s) => [s.sessionId, s]));
    expect(sessions.get(sessionA)?.summary).toBe("session A summary");
    expect(sessions.get(sessionB)?.summary).toBe("session B summary");
    expect(sessions.get(sessionA)?.startedAt).toBe(
      new Date("2026-05-10T00:00:00Z").toISOString(),
    );
    expect(sessions.get(sessionB)?.startedAt).toBe(
      new Date("2026-05-11T00:00:00Z").toISOString(),
    );
  });

  it("scopes by workspace — foreign workspace token usage is invisible", async () => {
    const result = await repo.rollupForAgent({
      agentId,
      workspaceId,
      window: "all" as AgentCostWindow,
      now: new Date("2026-05-13T00:00:00Z"),
    });
    const seen = result.topSessions.map((s) => s.sessionId);
    expect(seen).not.toContain(foreignSession);
  });

  it("a different workspace looking at our agentId sees nothing", async () => {
    // Cross-tenant idempotency: even with the real agentId, a caller
    // bound to a different workspace must come back empty. This is the
    // load-bearing tenancy check that the broken query was attempting.
    const result = await repo.rollupForAgent({
      agentId,
      workspaceId: otherWorkspaceId,
      window: "all" as AgentCostWindow,
      now: new Date("2026-05-13T00:00:00Z"),
    });
    expect(result.totals.inputTokens).toBe(0);
    expect(result.topSessions).toHaveLength(0);
  });

  it("windowed query (7d) still executes against real Postgres", async () => {
    // The windowed branch is a separately-templated SQL string; covering
    // it explicitly ensures the workspace_id reference didn't also slip
    // into the bounded path.
    const result = await repo.rollupForAgent({
      agentId,
      workspaceId,
      window: "7d" as AgentCostWindow,
      now: new Date("2026-05-13T00:00:00Z"),
    });
    expect(result.totals.inputTokens).toBe(3500);
    expect(result.topSessions).toHaveLength(2);
  });
});

describe("PostgresTokenUsageRepository.rollupForSession (real Postgres)", () => {
  it("returns the per-session totals scoped by workspace", async () => {
    const result = await repo.rollupForSession({
      sessionId: sessionA,
      workspaceId,
    });
    expect(result.sessionId).toBe(sessionA);
    expect(result.totals.inputTokens).toBe(1500);
    expect(result.totals.outputTokens).toBe(300);
  });

  it("returns zero totals when queried from the wrong workspace", async () => {
    const result = await repo.rollupForSession({
      sessionId: sessionA,
      workspaceId: otherWorkspaceId,
    });
    expect(result.totals.inputTokens).toBe(0);
  });
});

describe("PostgresTokenUsageRepository.rollupForWorkspace (real Postgres)", () => {
  it("rolls up across every agent in the workspace and excludes others", async () => {
    const result = await repo.rollupForWorkspace({
      workspaceId,
      since: new Date("2026-05-01T00:00:00Z"),
      until: new Date("2026-06-01T00:00:00Z"),
    });
    expect(result.totals.inputTokens).toBe(3500);
    expect(result.byAgent.find((a) => a.agentId === agentId)).toBeTruthy();
    expect(
      result.byAgent.find((a) => a.agentId === otherAgentId),
    ).toBeUndefined();
  });
});
