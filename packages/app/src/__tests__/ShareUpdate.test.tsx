import { describe, it, expect } from "bun:test";
import {
  shareUrl,
  shareContentVersion,
  type AgentSharePayload,
} from "../features/sessions/ShareCard";

/**
 * X1A-92 — when an agent updates an existing share (same share_id,
 * new file bytes), the browser must re-fetch new content. Without a
 * cache-buster the URL string is identical to the prior render and
 * the HTTP cache serves stale bytes.
 *
 * The cache-buster is a `?v=<updated_at_ms>` query suffix derived
 * from the sidecar's `updated_at_ms` field on the agent.share
 * payload. These tests pin the URL-composition contract so the bug
 * can't silently come back.
 */

const basePayload: AgentSharePayload = {
  share_id: "share_abc",
  share_type: "document",
  title: "Plan.md",
  path: "plan.md",
  files: [
    { path: "plan.md", size: 100, content_type: "text/markdown" },
  ],
  total_size: 100,
};

describe("shareUrl + shareContentVersion", () => {
  it("omits ?v= when no version is supplied", () => {
    const url = shareUrl("ws", "sess", "share_abc", "plan.md");
    expect(url).toContain("/api/workspaces/ws/sessions/sess/shares/share_abc/plan.md");
    expect(url).not.toContain("?v=");
  });

  it("appends ?v=<n> when version is supplied", () => {
    const url = shareUrl("ws", "sess", "share_abc", "plan.md", 12345);
    expect(url).toContain("?v=12345");
  });

  it("uses & when the path already has a query string", () => {
    // Future-proofing: if the path ever carries a query, the
    // cache-buster appends with `&`, not a second `?`.
    const url = shareUrl("ws", "sess", "share_abc", "plan.md?foo=bar", 12345);
    expect(url).toContain("plan.md?foo=bar&v=12345");
  });

  it("derives the version from payload.updated_at_ms when present", () => {
    const payload = { ...basePayload, updated_at_ms: 1_700_000_000_001 };
    expect(shareContentVersion(payload)).toBe(1_700_000_000_001);
  });

  it("falls back to the surrounding event seq when updated_at_ms is missing", () => {
    // Older payloads (before X1A-92's sidecar change) don't carry
    // updated_at_ms; the event's seq still distinguishes original
    // vs update.
    expect(shareContentVersion(basePayload, 42)).toBe(42);
  });

  it("returns undefined when neither updated_at_ms nor a fallback seq is available", () => {
    expect(shareContentVersion(basePayload)).toBeUndefined();
  });

  it("produces different URLs for two events with the same share_id but different updated_at_ms (re-render contract)", () => {
    // This is the X1A-92 contract: the same share_id with a fresh
    // updated_at_ms produces a different URL string so the browser
    // bypasses cache.
    const v1 = shareUrl(
      "ws",
      "sess",
      "share_abc",
      "plan.md",
      shareContentVersion({ ...basePayload, updated_at_ms: 1000 }),
    );
    const v2 = shareUrl(
      "ws",
      "sess",
      "share_abc",
      "plan.md",
      shareContentVersion({ ...basePayload, updated_at_ms: 2000 }),
    );
    expect(v1).not.toBe(v2);
    expect(v1).toContain("?v=1000");
    expect(v2).toContain("?v=2000");
  });
});
