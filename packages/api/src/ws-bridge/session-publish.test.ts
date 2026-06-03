import { describe, expect, it } from "bun:test";
import { decideSessionPublish } from "./index.js";
import { UserId } from "@x1agent/kernel";

/**
 * Session-actor isolation: pinned at the WS-bridge boundary. The
 * agent pod binds the triggering user's remote_oauth credentials at
 * session-launch; if a non-triggerer could publish turns, the agent
 * would silently act on those upstream services using credentials
 * the new actor never authorised. Authentication-context confusion.
 *
 * View is workspace-wide (a teammate can WATCH a session). Publish
 * is strictly the triggerer.
 */

const OWNER = UserId("00000000-0000-7000-8000-000000000001");
const OTHER = UserId("00000000-0000-7000-8000-000000000002");

describe("decideSessionPublish — session-actor isolation policy", () => {
  it("returns ok when the actor is the session triggerer", () => {
    const decision = decideSessionPublish({
      session: { triggeredByUserId: OWNER },
      actor: OWNER,
    });
    expect(decision.ok).toBe(true);
  });

  it("returns not_session_owner when the actor is a different workspace member", () => {
    const decision = decideSessionPublish({
      session: { triggeredByUserId: OWNER },
      actor: OTHER,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("not_session_owner");
    }
  });

  it("returns not_found when the session row is missing", () => {
    const decision = decideSessionPublish({
      session: null,
      actor: OWNER,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("not_found");
    }
  });

  it("rejects publish even when the session row has a null triggered_by_user_id", () => {
    // Scheduler-fired or system-spawned sessions have no human actor
    // bound; nobody should be allowed to publish into one this way.
    // (Future: a separate orchestrator-publish path may relax this,
    // but the user-fired publish surface stays strict.)
    const decision = decideSessionPublish({
      session: { triggeredByUserId: null },
      actor: OWNER,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe("not_session_owner");
    }
  });
});
