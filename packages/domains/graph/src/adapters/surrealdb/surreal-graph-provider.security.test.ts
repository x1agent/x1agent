import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { CollectionHandle } from "../../domain/collection-handle.js";
import {
  InvalidGraphQueryError,
  MultiStatementNotAllowedError,
} from "../../domain/errors.js";
import { SurrealClient } from "./surreal-client.js";
import { SurrealGraphProvider } from "./surreal-graph-provider.js";

/**
 * Behavioral regression for t03 P0 #2. We don't need a real SurrealDB
 * here — the guard is supposed to short-circuit BEFORE the body
 * reaches `/sql`. If the mock fetch is invoked for any of the rejected
 * cases, the guard failed. Conversely, the legitimate paths must
 * exercise fetch so we know we haven't accidentally broken the happy
 * path.
 */

const ORIGINAL_FETCH = globalThis.fetch;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function installFetchMock(): {
  calls: FetchCall[];
  reply: (body: unknown) => void;
} {
  const calls: FetchCall[] = [];
  let nextBody: unknown = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      headers: headers ?? {},
      body: (init?.body as string) ?? "",
    });
    return new Response(JSON.stringify(nextBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    reply(body: unknown) {
      nextBody = body;
    },
  };
}

function buildClient(): SurrealClient {
  return new SurrealClient({
    url: "http://surrealdb.example",
    username: "root",
    password: "secret",
    namespace: "x1agent",
  });
}

describe("SurrealGraphProvider.query (Layer 1 — denylist)", () => {
  let mock: ReturnType<typeof installFetchMock>;
  let provider: SurrealGraphProvider;
  const handle = CollectionHandle("col_workspace_a_ideas");

  beforeEach(() => {
    mock = installFetchMock();
    provider = new SurrealGraphProvider(buildClient());
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("USE DB <foreign> never reaches the network", async () => {
    let thrown: unknown;
    try {
      await provider.query({
        collection: handle,
        query: "USE DB col_workspace_b_ideas; SELECT * FROM person;",
        vars: {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidGraphQueryError);
    expect(mock.calls.length).toBe(0);
  });

  it("comment-hidden USE never reaches the network", async () => {
    let thrown: unknown;
    try {
      await provider.query({
        collection: handle,
        query: "/* USE */ USE DB col_workspace_b_ideas;",
        vars: {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidGraphQueryError);
    expect(mock.calls.length).toBe(0);
  });

  it("DEFINE / REMOVE / INFO FOR ROOT all rejected", async () => {
    for (const q of [
      "DEFINE TABLE secrets SCHEMALESS;",
      "REMOVE DATABASE col_workspace_b_ideas;",
      "INFO FOR ROOT;",
    ]) {
      let thrown: unknown;
      try {
        await provider.query({ collection: handle, query: q, vars: {} });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InvalidGraphQueryError);
    }
    expect(mock.calls.length).toBe(0);
  });

  it("legitimate single-statement query reaches fetch with the collection handle as surreal-db", async () => {
    mock.reply([{ status: "OK", result: [] }]);
    await provider.query({
      collection: handle,
      query: "SELECT * FROM person LIMIT 10;",
      vars: {},
    });
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]!.headers["surreal-db"]).toBe("col_workspace_a_ideas");
    expect(mock.calls[0]!.headers["surreal-ns"]).toBe("x1agent");
    expect(mock.calls[0]!.body).toContain("SELECT * FROM person");
  });
});

describe("SurrealClient.sql (Layer 3 — multi-statement refusal)", () => {
  let mock: ReturnType<typeof installFetchMock>;
  let client: SurrealClient;

  beforeEach(() => {
    mock = installFetchMock();
    client = buildClient();
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("rejects multi-statement bodies by default", async () => {
    let thrown: unknown;
    try {
      await client.sql("SELECT 1; SELECT 2;");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MultiStatementNotAllowedError);
    expect(mock.calls.length).toBe(0);
  });

  it("rejects in-string-literal-semicolon plus a real second statement", async () => {
    // The first ; is inside the string and does NOT count. The
    // semicolon after the closing quote *does*, then there's a real
    // SELECT after it — that is a true multi-statement body and is
    // refused.
    let thrown: unknown;
    try {
      await client.sql("SELECT 'a;b' AS x; SELECT 1;");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MultiStatementNotAllowedError);
    expect(mock.calls.length).toBe(0);
  });

  it("allows multi-statement bodies when caller opts in (provision path)", async () => {
    mock.reply([{ status: "OK", result: null }]);
    await client.sql(
      `DEFINE TABLE foo SCHEMALESS;
       DEFINE TABLE bar SCHEMALESS;`,
      "col_workspace_a_ideas",
      { allowMultiStatement: true },
    );
    expect(mock.calls.length).toBe(1);
  });

  it("single-statement bodies always reach the network", async () => {
    mock.reply([{ status: "OK", result: [] }]);
    await client.sql("SELECT * FROM person;");
    expect(mock.calls.length).toBe(1);
  });
});
