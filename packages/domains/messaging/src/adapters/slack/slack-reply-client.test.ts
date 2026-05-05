import { describe, it, expect } from "bun:test";
import {
  SlackHttpReplyClient,
  SlackReplyError,
} from "./slack-reply-client.js";

function client(fakeFetch: typeof fetch) {
  return new SlackHttpReplyClient({ fetchFn: fakeFetch, timeoutMs: 5_000 });
}

function jsonResponse(status: number, body: object, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("SlackHttpReplyClient", () => {
  it("resolves on the happy path", async () => {
    const c = client((async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch);
    await expect(
      c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" }),
    ).resolves.toBeUndefined();
  });

  it("flags revoked tokens as kind=revoked (caller marks install revoked)", async () => {
    for (const code of ["token_revoked", "account_inactive", "invalid_auth", "token_expired"]) {
      const c = client(
        (async () => jsonResponse(200, { ok: false, error: code })) as unknown as typeof fetch,
      );
      let thrown: unknown;
      try {
        await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SlackReplyError);
      expect((thrown as SlackReplyError).kind).toBe("revoked");
      expect((thrown as SlackReplyError).slackErrorCode).toBe(code);
    }
  });

  it("flags rate-limited responses and preserves Retry-After", async () => {
    const c = client(
      (async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "30" },
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackReplyError);
    expect((thrown as SlackReplyError).kind).toBe("rate_limited");
    expect((thrown as SlackReplyError).retryAfterSeconds).toBe(30);
  });

  it("flags channel_not_found / not_in_channel as kind=channel_unavailable", async () => {
    for (const code of ["channel_not_found", "not_in_channel", "is_archived", "restricted_action"]) {
      const c = client(
        (async () => jsonResponse(200, { ok: false, error: code })) as unknown as typeof fetch,
      );
      let thrown: unknown;
      try {
        await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SlackReplyError);
      expect((thrown as SlackReplyError).kind).toBe("channel_unavailable");
    }
  });

  it("treats network errors as kind=transient", async () => {
    const c = client(
      (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackReplyError);
    expect((thrown as SlackReplyError).kind).toBe("transient");
    expect((thrown as SlackReplyError).slackErrorCode).toBe("network_error");
  });

  it("treats 5xx as kind=transient (HTTP code in slackErrorCode)", async () => {
    const c = client(
      (async () =>
        new Response("<html>bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackReplyError);
    expect((thrown as SlackReplyError).kind).toBe("transient");
    expect((thrown as SlackReplyError).slackErrorCode).toBe("http_502");
  });

  it("treats non-JSON 2xx as kind=transient invalid_response_body", async () => {
    const c = client(
      (async () =>
        new Response("<html>maintenance</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackReplyError);
    expect((thrown as SlackReplyError).kind).toBe("transient");
  });

  it("uses thread_ts when threadTs is set", async () => {
    let captured: any;
    const c = client(
      (async (_url: unknown, init: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return jsonResponse(200, { ok: true });
      }) as unknown as typeof fetch,
    );
    await c.postReply({ botToken: "xoxb", channel: "C1", text: "hi", threadTs: "1.0" });
    expect(captured.thread_ts).toBe("1.0");
  });
});
