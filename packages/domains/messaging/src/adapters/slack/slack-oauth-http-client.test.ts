import { describe, it, expect } from "bun:test";
import { SlackOAuthHttpClient } from "./slack-oauth-http-client.js";
import { SlackOAuthExchangeError } from "../../ports/slack-oauth-client.js";

function buildClient(fakeFetch: typeof fetch) {
  return new SlackOAuthHttpClient({
    clientId: "id",
    clientSecret: "secret",
    fetchFn: fakeFetch,
  });
}

function fakeResponse(init: {
  ok: boolean;
  status: number;
  body: string | object;
}): Response {
  if (typeof init.body === "string") {
    return new Response(init.body, {
      status: init.status,
      headers: { "content-type": "text/html" },
    });
  }
  return new Response(JSON.stringify(init.body), {
    status: init.status,
    headers: { "content-type": "application/json" },
  });
}

describe("SlackOAuthHttpClient", () => {
  it("returns a parsed result on the happy path", async () => {
    const client = buildClient(
      (async () =>
        fakeResponse({
          ok: true,
          status: 200,
          body: {
            ok: true,
            access_token: "xoxb-token",
            app_id: "A1",
            bot_user_id: "U1",
            team: { id: "T1", name: "Test" },
          },
        })) as unknown as typeof fetch,
    );
    const r = await client.exchangeCodeForToken({
      code: "code",
      redirectUri: "https://api/callback",
    });
    expect(r.accessToken).toBe("xoxb-token");
    expect(r.teamName).toBe("Test");
  });

  it("throws http_<status> when Slack returns a non-2xx", async () => {
    const client = buildClient(
      (async () =>
        fakeResponse({
          ok: false,
          status: 502,
          body: "<html>bad gateway</html>",
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await client.exchangeCodeForToken({
        code: "code",
        redirectUri: "https://api/callback",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackOAuthExchangeError);
    expect((thrown as SlackOAuthExchangeError).slackErrorCode).toBe("http_502");
  });

  it("throws invalid_response_body on a 2xx with non-JSON content", async () => {
    const client = buildClient(
      (async () =>
        fakeResponse({
          ok: true,
          status: 200,
          body: "<html>maintenance</html>",
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await client.exchangeCodeForToken({
        code: "code",
        redirectUri: "https://api/callback",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackOAuthExchangeError);
    expect((thrown as SlackOAuthExchangeError).slackErrorCode).toBe(
      "invalid_response_body",
    );
  });

  it("throws network_error when fetch itself rejects", async () => {
    const client = buildClient(
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await client.exchangeCodeForToken({
        code: "code",
        redirectUri: "https://api/callback",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackOAuthExchangeError);
    expect((thrown as SlackOAuthExchangeError).slackErrorCode).toBe(
      "network_error",
    );
  });

  it("propagates Slack's own ok:false error code", async () => {
    const client = buildClient(
      (async () =>
        fakeResponse({
          ok: true,
          status: 200,
          body: { ok: false, error: "invalid_code" },
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await client.exchangeCodeForToken({
        code: "code",
        redirectUri: "https://api/callback",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackOAuthExchangeError);
    expect((thrown as SlackOAuthExchangeError).slackErrorCode).toBe(
      "invalid_code",
    );
  });

  it("throws missing_fields when Slack omits a required field", async () => {
    const client = buildClient(
      (async () =>
        fakeResponse({
          ok: true,
          status: 200,
          // No access_token. Slack's own ok:true.
          body: { ok: true, app_id: "A1", bot_user_id: "U1", team: { id: "T1" } },
        })) as unknown as typeof fetch,
    );
    let thrown: unknown;
    try {
      await client.exchangeCodeForToken({
        code: "code",
        redirectUri: "https://api/callback",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SlackOAuthExchangeError);
    expect((thrown as SlackOAuthExchangeError).slackErrorCode).toBe(
      "missing_fields",
    );
  });
});
