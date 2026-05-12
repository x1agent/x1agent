import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  formatTokens,
  formatUsd,
  useCostStore,
} from "../stores/costStore";
import { SessionCostBlock } from "../features/sessions/SessionCostBlock";
import { buildSparkline } from "../features/agents/AgentCostCard";

/**
 * Component + helper tests for the X1A-37 cost surfacing UI. The
 * sparkline + format helpers are pure; the component tests pre-seed
 * the cost store and render against happy-dom so we exercise the
 * zustand selector path that powers the live block.
 */

beforeEach(() => {
  useCostStore.setState({
    sessionCostBySession: {},
    treeCostBySession: {},
    agentCostByKey: {},
    loadingByKey: {},
    errorByKey: {},
  });
});
afterEach(() => cleanup());

describe("formatUsd", () => {
  it("renders sub-dollar with 4 decimals", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });
  it("renders 1–10 with 3 decimals", () => {
    expect(formatUsd(1.234)).toBe("$1.234");
  });
  it("renders 10+ with 2 decimals", () => {
    expect(formatUsd(123.456)).toBe("$123.46");
  });
});

describe("formatTokens", () => {
  it("uses raw count under 1K", () => {
    expect(formatTokens(120)).toBe("120");
  });
  it("uses K under 1M", () => {
    expect(formatTokens(12_400)).toBe("12.4K");
  });
  it("uses M under 1B", () => {
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("SessionCostBlock — markup", () => {
  it("renders the muted dashed-underline cost amount + live-dot", () => {
    useCostStore.setState({
      sessionCostBySession: {
        s1: {
          sessionId: "s1",
          totals: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEstimate: 4.23,
            cacheSavingsUsdEstimate: 0,
          },
          byModel: [],
        },
      },
    });
    const { container } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="s1"
        live={true}
        lastEventSeq={0}
      />,
    );
    const html = container.innerHTML;
    // Locked: dashed underline as hover-affordance.
    expect(html).toContain("border-dashed");
    expect(html).toContain("$4.23");
    // Locked: pulsing live-dot on the live "this session" amount.
    expect(html).toContain("animate-pulse");
    expect(html).toContain('aria-label="live"');
  });

  it("omits the live-dot when live=false (static aggregate row)", () => {
    const { container } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="sess-x"
        live={false}
        lastEventSeq={0}
      />,
    );
    expect(container.innerHTML).not.toContain('aria-label="live"');
  });

  it("renders the inline tree breakdown under the cost block when children exist", () => {
    useCostStore.setState({
      treeCostBySession: {
        p: {
          rootSessionId: "p",
          parent: {
            sessionId: "p",
            totals: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              costUsdEstimate: 2.1,
              cacheSavingsUsdEstimate: 0,
            },
            byModel: [],
          },
          children: [
            {
              sessionId: "00000000-0000-7000-8000-aaaaaaaaaaaa",
              depth: 1,
              summary: "worker doing thing",
              agentSlug: "worker",
              agentName: "worker",
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              costUsdEstimate: 1.2,
              cacheSavingsUsdEstimate: 0,
            },
          ],
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEstimate: 3.3,
            cacheSavingsUsdEstimate: 0,
          },
        },
      },
    });
    const { container } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="p"
        live={false}
        lastEventSeq={0}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("Session tree");
    expect(html).toContain("self");
    expect(html).toContain("$2.1"); // self row
    expect(html).toContain("$1.2"); // child row
    expect(html).toContain("$3.3"); // total
  });
});

describe("buildSparkline", () => {
  it("returns empty string on empty input", () => {
    expect(buildSparkline([])).toBe("");
  });

  it("produces an M-path starting at x=0 and ending at x=200", () => {
    const path = buildSparkline([
      { day: "2026-05-09", costUsdEstimate: 1 },
      { day: "2026-05-10", costUsdEstimate: 2 },
      { day: "2026-05-11", costUsdEstimate: 0.5 },
    ]);
    expect(path).toMatch(/^M 0\.0,/);
    expect(path).toMatch(/ L 200\.0,/);
  });

  it("places the highest-cost day at y=4 (top of viewBox)", () => {
    // 4 = 40 - 32 - 4. Single point => ratio 1 => y = 4.
    const path = buildSparkline([{ day: "2026-05-10", costUsdEstimate: 100 }]);
    expect(path).toContain(",4.0");
  });

  it("is order-independent on the input array (sorts by day string)", () => {
    const a = buildSparkline([
      { day: "2026-05-10", costUsdEstimate: 2 },
      { day: "2026-05-09", costUsdEstimate: 1 },
    ]);
    const b = buildSparkline([
      { day: "2026-05-09", costUsdEstimate: 1 },
      { day: "2026-05-10", costUsdEstimate: 2 },
    ]);
    expect(a).toBe(b);
  });
});

describe("useCostStore selector stability", () => {
  it("returns the same reference on consecutive reads with no writes", () => {
    useCostStore.setState({
      sessionCostBySession: {
        s1: {
          sessionId: "s1",
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEstimate: 0.5,
            cacheSavingsUsdEstimate: 0,
          },
          byModel: [],
        },
      },
    });
    const select = (s: ReturnType<typeof useCostStore.getState>) =>
      s.sessionCostBySession["s1"];
    const a = select(useCostStore.getState());
    const b = select(useCostStore.getState());
    expect(a).toBe(b);
  });
});
