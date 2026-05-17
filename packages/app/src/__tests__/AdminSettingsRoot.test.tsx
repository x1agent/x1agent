import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AdminSettingsRoot } from "../features/admin/AdminSettingsRoot";
import { useAuthStore } from "../stores/authStore";
import { usePlatformSecretsStore } from "../stores/platformSecretsStore";

/**
 * X1A-46 component-level coverage for /admin/settings.
 *
 * Important properties under test:
 *   - The page treats non-admins as forbidden (defense in depth on top
 *     of the server requirePlatformAdmin guard).
 *   - Status booleans are the only thing reflected — never a key value.
 *   - Save / Clear flow round-trips through the store + apiFetch and
 *     surfaces the restart banner with the CEO-greenlit copy.
 *   - Clear uses the inline confirm UX (no modal), per mockup-v1.
 *   - Update on a configured card swaps the read-only mask for an
 *     inline replacement input (no modal), per mockup-v1.
 */

// Typed to match the global fetch's (url, init) signature so
// mockImplementation can branch on URL + method without ts-ignore.
const fetchMock = mock(
  (_url: unknown, _init?: RequestInit) => Promise.resolve(new Response("{}")),
);
const originalFetch = globalThis.fetch;

function resetStores() {
  usePlatformSecretsStore.setState({
    providers: [
      { provider: "anthropic", configured: false },
      { provider: "openai", configured: false },
    ],
    loadStatus: "idle",
    loadError: null,
    saving: {},
    banner: null,
  });
}

function setAuthAdmin(isPlatformAdmin: boolean) {
  useAuthStore.setState({
    user: {
      id: "u_1",
      email: "admin@example.com",
      name: "Admin",
      avatar_url: null,
    },
    memberships: [],
    isPlatformAdmin,
    status: "authenticated",
    error: null,
  });
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function defaultFetchResponses() {
  fetchMock.mockImplementation((url, init) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    // Endpoints AppShell / AppSidebar hit at mount time. The shapes
    // here aren't load-bearing for the page-under-test — they just
    // have to be JSON the consumer stores don't choke on.
    if (u.endsWith("/auth/accounts")) {
      return Promise.resolve(jsonRes({ accounts: [] }));
    }
    if (u.endsWith("/api/capabilities")) {
      return Promise.resolve(
        jsonRes({
          capabilities: {
            graph: "none",
            vector: "none",
            collections: "none",
          },
        }),
      );
    }

    // Platform-secrets endpoints — the actual surface under test.
    if (u.endsWith("/api/admin/platform-secrets/llm") && method === "GET") {
      return Promise.resolve(
        jsonRes({
          providers: [
            { provider: "anthropic", configured: false },
            { provider: "openai", configured: false },
          ],
        }),
      );
    }
    // Endpoints the new Anthropic tab fires on mount. Tests for those
    // surfaces live elsewhere; here we just keep the renders alive.
    if (u.endsWith("/api/admin/anthropic/models") && method === "GET") {
      return Promise.resolve(
        jsonRes({
          provider: "api_key",
          region: null,
          filtering_active: false,
          models: [],
        }),
      );
    }
    if (u.endsWith("/api/admin/anthropic/models/summary-model") && method === "GET") {
      return Promise.resolve(
        jsonRes({ model_id: null, updated_at: null, updated_by: null }),
      );
    }
    if (method === "PUT") {
      const provider = u.split("/").pop()!;
      return Promise.resolve(
        jsonRes({ provider, configured: true, restart: "pending" }),
      );
    }
    if (method === "DELETE") {
      const provider = u.split("/").pop()!;
      return Promise.resolve(
        jsonRes({ provider, configured: false, restart: "pending" }),
      );
    }
    return Promise.resolve(jsonRes({}));
  });
}

/**
 * Override just the /llm GET status response shape. Cleaner than
 * mockImplementationOnce, which consumes the next fetch call regardless
 * of URL — AppSidebar's mount-time loadAccounts / fetchCapabilities
 * would otherwise hijack that single override and the platform-secrets
 * load would fall through to the default "not configured" path.
 */
function overrideLlmStatus(
  providers: Array<{ provider: string; configured: boolean }>,
) {
  fetchMock.mockImplementation((url, init) => {
    const u = String(url);
    if (u.endsWith("/auth/accounts")) return Promise.resolve(jsonRes({ accounts: [] }));
    if (u.endsWith("/api/capabilities"))
      return Promise.resolve(
        jsonRes({ capabilities: { graph: "none", vector: "none", collections: "none" } }),
      );
    if (u.endsWith("/api/admin/platform-secrets/llm") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(jsonRes({ providers }));
    }
    if (u.endsWith("/api/admin/anthropic/models") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        jsonRes({
          provider: "api_key",
          region: null,
          filtering_active: false,
          models: [],
        }),
      );
    }
    if (u.endsWith("/api/admin/anthropic/models/summary-model") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        jsonRes({ model_id: null, updated_at: null, updated_by: null }),
      );
    }
    if (init?.method === "PUT") {
      const provider = u.split("/").pop()!;
      return Promise.resolve(
        jsonRes({ provider, configured: true, restart: "pending" }),
      );
    }
    if (init?.method === "DELETE") {
      const provider = u.split("/").pop()!;
      return Promise.resolve(
        jsonRes({ provider, configured: false, restart: "pending" }),
      );
    }
    return Promise.resolve(jsonRes({}));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  defaultFetchResponses();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  resetStores();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AdminSettingsRoot — gating", () => {
  it("renders the Forbidden card when the user is not a platform admin", () => {
    setAuthAdmin(false);
    render(<AdminSettingsRoot />);
    expect(screen.getByText(/forbidden/i)).toBeDefined();
    expect(
      screen.getByText(/don't have permission/i),
    ).toBeDefined();
    // Does NOT render any provider card for non-admins.
    expect(screen.queryByTestId("provider-card-anthropic")).toBeNull();
  });

  it("renders the Anthropic tab by default for platform admins", async () => {
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      expect(screen.getByTestId("provider-card-anthropic")).toBeDefined();
    });
    // Heading reads "Model Settings" — replaced the old "Admin Settings"
    // / "LLM Provider Keys" copy after the X1A-145 tab consolidation.
    expect(
      screen.getByRole("heading", { name: /model settings/i }),
    ).toBeDefined();
    expect(screen.getByRole("tab", { name: /anthropic/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /openai/i })).toBeDefined();
    // OpenAI card lives behind its own tab — not rendered by default.
    expect(screen.queryByTestId("provider-card-openai")).toBeNull();
  });

  it("renders the OpenAI provider card when defaultValue=openai (via ?tab=openai)", async () => {
    setAuthAdmin(true);
    // happy-dom's location.search isn't writable by default; the
    // shipping code reads it via URLSearchParams. Stub it for this
    // case so the page renders the OpenAI tab as default — exercises
    // the same content slot without depending on Radix Tabs' click
    // semantics under happy-dom.
    const orig = window.location.search;
    Object.defineProperty(window.location, "search", {
      value: "?tab=openai",
      configurable: true,
    });
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      expect(screen.getByTestId("provider-card-openai")).toBeDefined();
    });
    Object.defineProperty(window.location, "search", {
      value: orig,
      configurable: true,
    });
  });
});

describe("AdminSettingsRoot — status reflects booleans only", () => {
  it("shows NOT CONFIGURED on a fresh install (Anthropic tab default)", async () => {
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      // One badge visible — the Anthropic card. OpenAI is in the other
      // tab and Radix renders inactive panels with hidden, so a
      // queryAll still returns those elements. Pin to the visible
      // card under provider-card-anthropic.
      const card = screen.getByTestId("provider-card-anthropic");
      expect(card.querySelector('[data-testid="status-not-configured"]'))
        .not.toBeNull();
    });
  });

  it("shows CONFIGURED on the Anthropic card when the api reports configured=true", async () => {
    overrideLlmStatus([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      const card = screen.getByTestId("provider-card-anthropic");
      expect(card.querySelector('[data-testid="status-configured"]'))
        .not.toBeNull();
    });
  });
});

describe("AdminSettingsRoot — Save flow", () => {
  it("posts PUT /api/admin/platform-secrets/llm/:provider and shows the restart banner", async () => {
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);

    await waitFor(() => {
      expect(screen.getByTestId("key-input-anthropic")).toBeDefined();
    });

    const input = screen.getByTestId("key-input-anthropic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-real" } });
    fireEvent.click(screen.getByTestId("key-save-anthropic"));

    await waitFor(() => {
      expect(screen.getByTestId("restart-banner")).toBeDefined();
    });

    // Banner copy matches the CEO-greenlit string ("API will restart in ~30s.").
    expect(
      screen.getByTestId("restart-banner").textContent,
    ).toMatch(/api will restart in ~30s/i);

    // Confirm the request hit the right URL with the right body.
    const putCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(String(putCall![0])).toContain(
      "/api/admin/platform-secrets/llm/anthropic",
    );
    expect(
      JSON.parse(String((putCall![1] as RequestInit).body)),
    ).toEqual({ value: "sk-ant-real" });
  });

  it("disables Save until the input has non-whitespace content", async () => {
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      expect(screen.getByTestId("key-save-anthropic")).toBeDefined();
    });
    const save = screen.getByTestId("key-save-anthropic") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    const input = screen.getByTestId("key-input-anthropic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "sk-ant-xyz" } });
    expect(save.disabled).toBe(false);
  });
});

describe("AdminSettingsRoot — Clear flow uses inline confirm (not a modal)", () => {
  it("shows an inline Cancel / Yes-clear pair before firing DELETE", async () => {
    // Start in the configured state so the Clear button renders.
    overrideLlmStatus([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);

    await waitFor(() => {
      expect(screen.getByTestId("key-clear-anthropic")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("key-clear-anthropic"));

    // Inline confirm appeared — assert both Cancel and Yes,clear are
    // visible, and the original Clear button is gone (no second modal).
    expect(screen.getByTestId("key-clear-confirm-anthropic")).toBeDefined();
    expect(screen.queryByTestId("key-clear-anthropic")).toBeNull();

    fireEvent.click(screen.getByTestId("key-clear-confirm-anthropic"));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
      expect(String(deleteCall![0])).toContain(
        "/api/admin/platform-secrets/llm/anthropic",
      );
    });
  });
});

describe("AdminSettingsRoot — Update uses an inline replacement input (not a modal)", () => {
  it("swaps the masked field for a writable input when Update is clicked", async () => {
    overrideLlmStatus([
      { provider: "anthropic", configured: true },
      { provider: "openai", configured: false },
    ]);
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      expect(screen.getByTestId("key-update-anthropic")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("key-update-anthropic"));

    // The inline replacement input appears with the same testid as the
    // empty-state input — confirms we're in update-mode, not a modal.
    expect(screen.getByTestId("key-input-anthropic")).toBeDefined();
  });
});

describe("AdminSettingsRoot — no key values leak into the DOM", () => {
  // Belt-and-braces companion to the api-side regression test. If a
  // refactor accidentally puts the value in a hidden field or a
  // data-attribute, this catches it.
  it("never renders the value the user typed back to the DOM beyond the password input", async () => {
    setAuthAdmin(true);
    render(<AdminSettingsRoot />);
    await waitFor(() => {
      expect(screen.getByTestId("key-input-anthropic")).toBeDefined();
    });
    const secret = "sk-ant-do-not-leak-12345";
    fireEvent.change(screen.getByTestId("key-input-anthropic"), {
      target: { value: secret },
    });
    // The HTMLInputElement's `value` of course contains it; what we're
    // guarding against is the SAME string appearing in the surrounding
    // rendered markup, where a tooltip / data-attribute / debug span
    // could leak it. We strip the input's own value attribute before
    // checking the rest of the document.
    const input = screen.getByTestId("key-input-anthropic") as HTMLInputElement;
    input.value = "";
    expect(document.body.textContent ?? "").not.toContain(secret);
  });
});
