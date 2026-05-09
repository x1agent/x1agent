import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreateWorkspaceRoot } from "../features/workspaces/CreateWorkspaceRoot";
import { useWorkspaceCreateStore } from "../stores/workspaceCreateStore";
import { useAuthStore } from "../stores/authStore";

// Hook into authStore directly so the form clears its "authorized?" gate
// without touching the network. The form short-circuits to <Loading/> when
// status is "idle" or "loading", and to a "not authorized" page when
// isPlatformAdmin is false — both bypass the form's actual UI.
function asPlatformAdmin() {
  useAuthStore.setState({
    user: {
      id: "u-1",
      email: "admin@x1agent.test",
      name: "Admin",
    } as never,
    memberships: [],
    isPlatformAdmin: true,
    status: "authenticated",
    error: null,
  });
}

const fetchMock = mock(() => Promise.resolve(new Response("{}")));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset both stores between tests so leftover state can't contaminate
  // the next case.
  useWorkspaceCreateStore.setState({
    name: "",
    slug: "",
    slugDirty: false,
    submitting: false,
    error: null,
  });
  asPlatformAdmin();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ slug: "acme" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("useWorkspaceCreateStore (selectors + actions)", () => {
  it("atomic primitive selectors return referentially stable values across reads", () => {
    // Mirrors how the component reads each primitive with its own
    // selector. The values we read are primitives, but the selector
    // FUNCTIONS need to be stable across renders too — and the store
    // identity itself must not change. This is the foot-gun called out
    // in CLAUDE.md: a selector that returns a fresh object/array each
    // render breaks zustand's render-bailout and trips React error #185.
    const sel = (s: ReturnType<typeof useWorkspaceCreateStore.getState>) =>
      s.name;
    const a = sel(useWorkspaceCreateStore.getState());
    const b = sel(useWorkspaceCreateStore.getState());
    expect(a).toBe(b);

    // Action references are part of the store and must be stable across
    // reads (otherwise components depending on them re-render forever).
    const setNameA = useWorkspaceCreateStore.getState().setName;
    const setNameB = useWorkspaceCreateStore.getState().setName;
    expect(setNameA).toBe(setNameB);
    const submitA = useWorkspaceCreateStore.getState().submit;
    const submitB = useWorkspaceCreateStore.getState().submit;
    expect(submitA).toBe(submitB);
  });

  it("setName updates name AND auto-derives slug while not dirty", () => {
    useWorkspaceCreateStore.getState().setName("Acme Engineering");
    const { name, slug, slugDirty } = useWorkspaceCreateStore.getState();
    expect(name).toBe("Acme Engineering");
    expect(slug).toBe("acme-engineering");
    expect(slugDirty).toBe(false);
  });

  it("setName leaves slug alone once slugDirty is true", () => {
    const s = useWorkspaceCreateStore.getState();
    s.setName("Acme");
    s.setSlug("custom-slug"); // diverges from slugify("Acme") → dirty
    expect(useWorkspaceCreateStore.getState().slugDirty).toBe(true);
    s.setName("Beta Corp");
    // Manual edit wins — the slug must NOT be overwritten.
    expect(useWorkspaceCreateStore.getState().slug).toBe("custom-slug");
  });

  it("clearing the slug re-enables auto-tracking", () => {
    const s = useWorkspaceCreateStore.getState();
    s.setName("Acme");
    s.setSlug("custom-slug");
    expect(useWorkspaceCreateStore.getState().slugDirty).toBe(true);
    s.setSlug(""); // clear the field
    expect(useWorkspaceCreateStore.getState().slugDirty).toBe(false);
    s.setName("Beta Corp");
    // Auto-tracking is back, the new name re-derives the slug.
    expect(useWorkspaceCreateStore.getState().slug).toBe("beta-corp");
  });
});

describe("CreateWorkspaceRoot (component)", () => {
  it("renders the form and reflects values from the store", () => {
    render(<CreateWorkspaceRoot />);
    // Component clears the draft on mount (useEffect → reset) so a stale
    // attempt's name/slug doesn't leak into a fresh visit. Populating the
    // store AFTER mount mirrors how a real user fills the form, and it's
    // also how callers would prefill (e.g. from a deep link).
    // act() wraps the synchronous set so React flushes its subscribers.
    act(() => {
      useWorkspaceCreateStore.setState({
        name: "Acme",
        slug: "acme",
        slugDirty: false,
        submitting: false,
        error: null,
      });
    });
    const nameInput = screen.getByLabelText("Workspace name") as HTMLInputElement;
    const slugInput = screen.getByLabelText("URL slug") as HTMLInputElement;
    expect(nameInput.value).toBe("Acme");
    expect(slugInput.value).toBe("acme");
    expect(screen.getByRole("button", { name: /create workspace/i })).toBeDefined();
  });

  it("typing into the name field auto-fills the slug via the store", () => {
    render(<CreateWorkspaceRoot />);
    const nameInput = screen.getByLabelText("Workspace name") as HTMLInputElement;
    const slugInput = screen.getByLabelText("URL slug") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Acme Engineering" } });
    expect(nameInput.value).toBe("Acme Engineering");
    // Slug auto-tracks the name through the zustand store, not local
    // useState — this is the whole point of the refactor.
    expect(slugInput.value).toBe("acme-engineering");
    expect(useWorkspaceCreateStore.getState().slug).toBe("acme-engineering");
  });

  it("manual slug edits are preserved when the name changes (dirty flag)", () => {
    render(<CreateWorkspaceRoot />);
    const nameInput = screen.getByLabelText("Workspace name") as HTMLInputElement;
    const slugInput = screen.getByLabelText("URL slug") as HTMLInputElement;

    fireEvent.change(nameInput, { target: { value: "Acme" } });
    expect(slugInput.value).toBe("acme");

    // User types a custom slug — diverges from slugify("Acme").
    fireEvent.change(slugInput, { target: { value: "acme-corp" } });
    expect(slugInput.value).toBe("acme-corp");
    expect(useWorkspaceCreateStore.getState().slugDirty).toBe(true);

    // Now changing the name MUST NOT overwrite the manual slug.
    fireEvent.change(nameInput, { target: { value: "Acme Engineering" } });
    expect(nameInput.value).toBe("Acme Engineering");
    expect(slugInput.value).toBe("acme-corp");
    expect(useWorkspaceCreateStore.getState().slug).toBe("acme-corp");
  });
});
