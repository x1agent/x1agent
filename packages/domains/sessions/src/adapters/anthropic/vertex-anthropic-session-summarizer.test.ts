import { describe, expect, it } from "bun:test";
import { VertexAnthropicSessionSummarizer } from "./vertex-anthropic-session-summarizer.js";
import type { SessionEvent } from "../../domain/session-event.js";

// Vertex's global endpoint is the unprefixed aiplatform.googleapis.com host;
// every other region uses `<region>-aiplatform.googleapis.com`. We build the
// URL by hand, so a regression here returns 404 HTML for every summary call
// (which is exactly the bug that took summaries down on installs running
// CLOUD_ML_REGION=global).
describe("VertexAnthropicSessionSummarizer URL construction", () => {
  const minimalEvent: SessionEvent = {
    id: "evt_1",
    sessionId: "sess_1",
    seq: 1,
    type: "user.message",
    payload: { text: "hello" },
    createdAt: new Date(),
  } as SessionEvent;

  async function captureUrl(region: string): Promise<string> {
    let observedUrl = "";
    const stubFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      observedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ content: [{ text: "ok" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const summarizer = new VertexAnthropicSessionSummarizer({
      projectId: "test-project",
      region,
      fetchImpl: stubFetch,
      // Skip the metadata-server token fetch.
      metadataBaseUrl: "http://stub-metadata",
    });
    // Inject a token by stubbing the metadata fetch — simpler: monkey-patch
    // private method via prototype access.
    (summarizer as unknown as { fetchAccessToken: () => Promise<string> })
      .fetchAccessToken = async () => "stub-token";
    await summarizer.summarize([minimalEvent]);
    return observedUrl;
  }

  it("uses the per-region host for a regional location", async () => {
    const url = await captureUrl("us-east5");
    expect(url).toStartWith("https://us-east5-aiplatform.googleapis.com/");
    expect(url).toContain("/locations/us-east5/");
  });

  it("uses the unprefixed host for the global endpoint", async () => {
    const url = await captureUrl("global");
    // Must NOT be `global-aiplatform.googleapis.com` — that host returns 404.
    expect(url).not.toContain("global-aiplatform.googleapis.com");
    expect(url).toStartWith("https://aiplatform.googleapis.com/");
    expect(url).toContain("/locations/global/");
  });
});
