import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { useGitHubStore } from "../stores/githubStore";

const SLUG = "ws";
const AGENT_ID = "agent-1";

const fetchMock = mock(() => Promise.resolve(new Response("{}")));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset store between tests so attachRepo / updateRepo see a clean
  // load path. They each end with loadAgentRepos, which hits the API
  // again -- our mock returns empty {} for that read too.
  useGitHubStore.setState({
    config: null,
    installations: [],
    status: "idle",
    error: null,
    reposById: {},
    reposLoadingId: null,
    agentRepos: {},
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ installation_id: 0, repos: [] }), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function lastPostBody(path: string): Record<string, unknown> | null {
  // Walk every fetch call this test made. Find the one matching the
  // method + path tail. Returns the parsed JSON body. The store hits
  // `apiFetch` which prefixes with API_BASE, so we match on path tail.
  for (const call of fetchMock.mock.calls.slice().reverse()) {
    const [url, init] = call as [string, RequestInit | undefined];
    if (typeof url === "string" && url.endsWith(path) && init?.body) {
      return JSON.parse(init.body as string);
    }
  }
  return null;
}

describe("githubStore.attachRepo wire shape", () => {
  it("includes allow_push=true when caller passes true", async () => {
    await useGitHubStore.getState().attachRepo(SLUG, AGENT_ID, 100, "x1/foo", {
      branch: "main",
      allow_push: true,
    });
    const body = lastPostBody(`/api/workspaces/${SLUG}/agents/${AGENT_ID}/repos`);
    expect(body).not.toBeNull();
    expect(body!.allow_push).toBe(true);
    expect(body!.installation_id).toBe(100);
    expect(body!.repo_full_name).toBe("x1/foo");
  });

  it("includes allow_push=false when caller passes false", async () => {
    await useGitHubStore.getState().attachRepo(SLUG, AGENT_ID, 100, "x1/foo", {
      branch: "main",
      allow_push: false,
    });
    const body = lastPostBody(`/api/workspaces/${SLUG}/agents/${AGENT_ID}/repos`);
    expect(body!.allow_push).toBe(false);
  });

  it("regression: caller MUST be able to send allow_push (the bug was the field not making it into the body)", async () => {
    // Before the fix, attachRepo destructured only `branch` and `auto_push`
    // from options — `allow_push` was silently dropped. The body contained
    // `"allow_push": undefined`, which JSON.stringify omits, which made
    // the API receive nothing, which let the postgres column default
    // (false) win. Pin the shape so the regression can't return.
    await useGitHubStore.getState().attachRepo(SLUG, AGENT_ID, 100, "x1/foo", {
      allow_push: true,
    });
    const body = lastPostBody(`/api/workspaces/${SLUG}/agents/${AGENT_ID}/repos`);
    expect("allow_push" in body!).toBe(true);
  });
});

describe("githubStore.updateRepo wire shape", () => {
  it("PATCH includes allow_push when caller passes it", async () => {
    await useGitHubStore.getState().updateRepo(SLUG, AGENT_ID, "x1/foo", {
      allow_push: false,
    });
    const body = lastPostBody(
      `/api/workspaces/${SLUG}/agents/${AGENT_ID}/repos/${encodeURIComponent("x1/foo")}`,
    );
    expect(body).not.toBeNull();
    expect(body!.allow_push).toBe(false);
  });

  it("PATCH still works when caller only sends branch (allow_push absent)", async () => {
    await useGitHubStore.getState().updateRepo(SLUG, AGENT_ID, "x1/foo", {
      branch: "develop",
    });
    const body = lastPostBody(
      `/api/workspaces/${SLUG}/agents/${AGENT_ID}/repos/${encodeURIComponent("x1/foo")}`,
    );
    expect(body!.branch).toBe("develop");
    expect(body!.allow_push).toBeUndefined();
  });
});
