import { describe, it, expect } from "bun:test";
import { renderToString } from "react-dom/server";
import type { SessionDTO } from "@x1agent/shared";
import { SessionTitle } from "../features/sessions/SessionTitle";

const SESSION_ID = "00000000-0000-7000-8000-000000000abc";

function makeSession(overrides: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: SESSION_ID,
    agent_id: "00000000-0000-7000-8000-0000000000a1",
    triggered_by: "user",
    triggered_by_user_id: "00000000-0000-7000-8000-00000000a1ce",
    parent_session_id: null,
    parent_agent_id: null,
    resumed_from: null,
    triggered_at: "2026-05-09T12:00:00.000Z",
    status: "running",
    completed_at: null,
    error_message: null,
    created_at: "2026-05-09T12:00:00.000Z",
    summary: null,
    summary_updated_at: null,
    ...overrides,
  };
}

describe("SessionTitle", () => {
  it("renders the LLM summary when one is present", () => {
    const html = renderToString(
      <SessionTitle
        session={makeSession({ summary: "user is debugging the login flow" })}
        sessionId={SESSION_ID}
      />,
    );
    expect(html).toContain("user is debugging the login flow");
    // The id hash is still rendered alongside as a co-pilot for
    // unambiguous reference.
    expect(html).toContain("00000000");
  });

  it("falls back to the id hash and 'no summary yet' when summary is null", () => {
    const html = renderToString(
      <SessionTitle
        session={makeSession({ summary: null })}
        sessionId={SESSION_ID}
      />,
    );
    expect(html).toContain("00000000");
    expect(html).toContain("no summary yet");
  });

  it("ignores whitespace-only summaries and uses the fallback", () => {
    const html = renderToString(
      <SessionTitle
        session={makeSession({ summary: "   \n  \t  " })}
        sessionId={SESSION_ID}
      />,
    );
    expect(html).toContain("no summary yet");
  });

  it("uses the truncate utility on the summary text", () => {
    // Long summaries appear in a flex row with shrinking neighbours;
    // without `truncate` (and `min-w-0` on the parent) the row
    // overflows horizontally and pushes Resume / Verbose buttons
    // off-screen. This test guards against losing those classes.
    const longSummary =
      "User is debugging an authentication flow that fails intermittently when the OAuth callback races against the session-rotate refresh, possibly because the cookie domain is wrong";
    const html = renderToString(
      <SessionTitle
        session={makeSession({ summary: longSummary })}
        sessionId={SESSION_ID}
      />,
    );
    expect(html).toContain(longSummary);
    expect(html).toContain("truncate");
    // Parent must allow flex children to shrink.
    expect(html).toContain("min-w-0");
    // Hover-reveal — full text is the title attribute.
    expect(html).toContain(`title="${longSummary}"`);
  });

  it("renders the fallback hash with monospace + truncate when there is no session yet", () => {
    const html = renderToString(
      <SessionTitle session={null} sessionId={SESSION_ID} />,
    );
    expect(html).toContain("00000000");
    expect(html).toContain("truncate");
    expect(html).toContain("font-mono");
  });
});
