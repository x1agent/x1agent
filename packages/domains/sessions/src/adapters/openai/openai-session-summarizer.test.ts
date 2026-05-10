import { describe, it, expect } from "bun:test";
import type { SessionEvent } from "../../domain/event.js";
import { OpenAISessionSummarizer } from "./openai-session-summarizer.js";

const SID = "11111111-1111-7111-8111-111111111111";

function ev(type: string, seq: number, payload: unknown = {}): SessionEvent {
  return {
    sessionId: SID as unknown as SessionEvent["sessionId"],
    seq,
    type,
    payload,
    timestamp: new Date(`2026-01-01T00:00:0${seq % 10}Z`),
  } as SessionEvent;
}

const SAMPLE_EVENTS: readonly SessionEvent[] = [
  ev("session.started", 1, { prompt: "Help me ship the OpenAI summarizer." }),
  ev("user.message", 2, { text: "Pull the latest perf branch." }),
  ev("agent.text", 3, { text: "Pulling now." }),
  ev("agent.tool_call", 4, { name: "Bash" }),
];

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAISessionSummarizer", () => {
  it("returns null when constructed without an api key", async () => {
    const s = new OpenAISessionSummarizer({ apiKey: "" });
    expect(await s.summarize(SAMPLE_EVENTS)).toBeNull();
  });

  it("returns null when the transcript is empty (no public events)", async () => {
    let called = 0;
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () => {
        called++;
        return jsonResponse({});
      }) as typeof fetch,
    });
    expect(await s.summarize([])).toBeNull();
    expect(called).toBe(0);
  });

  it("posts to /v1/chat/completions with bearer auth and the configured model", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.example",
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return jsonResponse({
          choices: [{ message: { content: "Ships the OpenAI summarizer." } }],
        });
      }) as typeof fetch,
    });

    const out = await s.summarize(SAMPLE_EVENTS);
    expect(out).toBe("Ships the OpenAI summarizer.");
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "https://api.openai.example/v1/chat/completions",
    );
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain(
      "Summarize this session in one short line",
    );
    expect(body.messages[1].content).toContain("user: Pull the latest");
  });

  it("trims surrounding whitespace and truncates very long outputs", async () => {
    const long = "a".repeat(500);
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () =>
        jsonResponse({
          choices: [{ message: { content: `   ${long}\n  ` } }],
        })) as typeof fetch,
    });
    const out = await s.summarize(SAMPLE_EVENTS);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(120);
    expect(out!.startsWith("a")).toBe(true);
  });

  it("returns null on non-2xx without throwing", async () => {
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () =>
        new Response("{\"error\":\"rate_limit\"}", { status: 429 })) as typeof fetch,
    });
    expect(await s.summarize(SAMPLE_EVENTS)).toBeNull();
  });

  it("returns null when the upstream returns malformed JSON", async () => {
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () =>
        new Response("<html>500</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as typeof fetch,
    });
    expect(await s.summarize(SAMPLE_EVENTS)).toBeNull();
  });

  it("returns null when fetch itself rejects (network)", async () => {
    const s = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () => {
        throw new Error("ENETDOWN");
      }) as typeof fetch,
    });
    expect(await s.summarize(SAMPLE_EVENTS)).toBeNull();
  });

  it("returns null when choices is missing or content is non-string", async () => {
    const s1 = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    });
    expect(await s1.summarize(SAMPLE_EVENTS)).toBeNull();

    const s2 = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () =>
        jsonResponse({ choices: [{ message: { content: null } }] })) as typeof fetch,
    });
    expect(await s2.summarize(SAMPLE_EVENTS)).toBeNull();

    const s3 = new OpenAISessionSummarizer({
      apiKey: "sk-test",
      fetchImpl: (async () =>
        jsonResponse({ choices: [] })) as typeof fetch,
    });
    expect(await s3.summarize(SAMPLE_EVENTS)).toBeNull();
  });
});
