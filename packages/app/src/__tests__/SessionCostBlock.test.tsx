import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
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

  /**
   * Helper: seed the cost store with a tree-cost record (parent + one
   * child + total) so the toggle becomes available. Several specs
   * below share the same shape.
   */
  function seedTreeCost() {
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
  }

  it("hides the session tree by default and exposes a collapsed toggle (X1A-116)", () => {
    seedTreeCost();
    const { container, getByTestId } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="p"
        live={false}
        lastEventSeq={0}
      />,
    );
    const html = container.innerHTML;
    // Tree content is absent in the default collapsed state.
    expect(html).not.toContain("Session tree");
    expect(html).not.toContain("Total");
    // Caret is rendered and reports its collapsed state via aria-expanded.
    const toggle = getByTestId("session-tree-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows the inline session+workers math when children exist (collapsed default)", () => {
    seedTreeCost();
    const { container, getByTestId } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="p"
        live={false}
        lastEventSeq={0}
      />,
    );
    const html = container.innerHTML;
    // Self amount (this session), worker amount, grand total are all
    // visible in the headline pill before the tree is expanded.
    expect(html).toContain("$2.1"); // self
    expect(html).toContain("$1.2"); // workers sum
    // Grand total is rendered as font-medium, marked with its own testid.
    expect(getByTestId("session-tree-grand-total").textContent).toContain(
      "$3.3",
    );
    // Plus / equals separators are present (inside aria-hidden spans).
    expect(html).toContain(">+<");
    expect(html).toContain(">=<");
    // Worker context lives in the tooltip; no inline "N workers" label
    // (it was too long inside the 18rem header pill).
    expect(html).toContain("Across 1 worker");
    // Caret renders on the far right of the row.
    const toggle = getByTestId("session-tree-toggle");
    expect(toggle.className).toContain("ml-auto");
  });

  it("pluralizes the worker label to '3 workers' in the tooltip when there are multiple children", () => {
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
              costUsdEstimate: 1,
              cacheSavingsUsdEstimate: 0,
            },
            byModel: [],
          },
          children: ["a", "b", "c"].map((slug, idx) => ({
            sessionId: `00000000-0000-7000-8000-aaaaaaaaaaa${idx}`,
            depth: 1,
            summary: `worker ${slug}`,
            agentSlug: slug,
            agentName: slug,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEstimate: 0.5,
            cacheSavingsUsdEstimate: 0,
          })),
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            costUsdEstimate: 2.5,
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
    expect(container.innerHTML).toContain("Across 3 workers");
  });

  it("expands the session tree on caret click and collapses again on a second click (X1A-116)", () => {
    seedTreeCost();
    const { container, getByTestId } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="p"
        live={false}
        lastEventSeq={0}
      />,
    );
    const toggle = getByTestId("session-tree-toggle");
    fireEvent.click(toggle);
    let html = container.innerHTML;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(html).toContain("Session tree");
    expect(html).toContain("self");
    expect(html).toContain("$2.1"); // self row
    expect(html).toContain("$1.2"); // child row
    expect(html).toContain("$3.3"); // total

    fireEvent.click(toggle);
    html = container.innerHTML;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(html).not.toContain("Session tree");
  });

  it("omits the caret toggle entirely when the tree has no children", () => {
    // Only a `sessionCost` is seeded — no `treeCostBySession` entry,
    // so there's nothing to collapse and no caret should render.
    useCostStore.setState({
      sessionCostBySession: {
        solo: {
          sessionId: "solo",
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
    const { container, queryByTestId } = render(
      <SessionCostBlock
        workspaceSlug="ws-a"
        sessionId="solo"
        live={false}
        lastEventSeq={0}
      />,
    );
    expect(queryByTestId("session-tree-toggle")).toBeNull();
    expect(container.innerHTML).not.toContain("Session tree");
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
