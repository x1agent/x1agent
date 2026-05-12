import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitIdentitySection } from "../features/auth/GitIdentitySection";
import { useGitIdentityStore } from "../stores/gitIdentityStore";

const fetchMock = mock(() => Promise.resolve(new Response("{}")));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset the store between cases so a previous test's identity doesn't
  // contaminate the next one's "no identity set yet" path.
  useGitIdentityStore.setState({
    identity: undefined,
    status: "idle",
    error: null,
    fieldError: null,
    saving: false,
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ git_identity: null }), {
        status: 200,
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

describe("GitIdentitySection", () => {
  it("renders the form with both fields and a Save button", async () => {
    render(<GitIdentitySection />);
    expect(screen.getByLabelText("Name")).toBeDefined();
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
    // Help-text note about GitHub email verification — the spec calls
    // this out as required UX so users don't end up with anonymous
    // commits and wonder why.
    expect(screen.getByText(/verified email/i)).toBeDefined();
  });

  it("submits the form and routes through the API as PUT /api/me/git-identity", async () => {
    fetchMock.mockImplementation((url, init) => {
      // Initial GET on mount returns null; subsequent PUT echoes back.
      if (init?.method === "PUT") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              git_identity: { name: "Jane", email: "jane@github.com" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ git_identity: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    render(<GitIdentitySection />);
    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Jane" } });
    fireEvent.change(emailInput, { target: { value: "jane@github.com" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      // The store should have flipped to a populated identity once the
      // PUT round-trips.
      expect(useGitIdentityStore.getState().identity).toEqual({
        name: "Jane",
        email: "jane@github.com",
      });
    });

    // Ensure the request actually went where we documented.
    const putCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(String(putCall![0])).toContain("/api/me/git-identity");
  });

  it("renders a field-level error when the API returns one", async () => {
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === "PUT") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "validation_error",
              field: "git_email",
              message: "git_email: must be a valid email address",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ git_identity: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    render(<GitIdentitySection />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Jane" },
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(useGitIdentityStore.getState().fieldError?.field).toBe(
        "git_email",
      );
    });
    // The component renders the message inline under the email field —
    // assert it's in the DOM rather than just in the store.
    await waitFor(() => {
      expect(
        screen.getByText(/must be a valid email address/i),
      ).toBeDefined();
    });
  });

  it("Save button is disabled until both fields have content", async () => {
    render(<GitIdentitySection />);
    const button = screen.getByRole("button", { name: /save/i }) as
      | HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Jane" },
    });
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "jane@example.com" },
    });
    expect(button.disabled).toBe(false);
  });
});
