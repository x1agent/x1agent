import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccountSwitcher } from "../features/auth/AccountSwitcher";
import { useAuthStore } from "../stores/authStore";
import { useAccountsStore } from "../stores/accountsStore";

/**
 * X1A-46 regression suite for the admin-gated menu entry.
 *
 * Why these assertions matter:
 *   1. The menu is the user's only signal that admin surfaces exist.
 *      A regression where isPlatformAdmin is ignored = invisible feature.
 *   2. Inverse: a regression that LEAKS the entry to non-admins is a
 *      defense-in-depth break (the server gate is the real one, but
 *      pretending an option is available leads to confusing 403s).
 *   3. The entry must NOT restructure the menu — this test pins the
 *      coexistence with Sign out so an accidental DropdownMenuContent
 *      rewrite from X1A-13 / X1A-42 doesn't silently nuke our entry.
 */

const baseUser = {
  id: "u_1",
  name: "Test User",
  email: "test.user@example.com",
  avatar_url: null,
};

function setAuth(opts: { isPlatformAdmin: boolean }) {
  useAuthStore.setState({
    user: baseUser,
    memberships: [],
    isPlatformAdmin: opts.isPlatformAdmin,
    status: "authenticated",
    error: null,
  });
}

beforeEach(() => {
  // Reset accounts store so list-accounts effect resolves to a stable
  // "no other accounts" state — the menu still renders without the
  // optional switch-account block.
  useAccountsStore.setState({
    accounts: [],
    status: "ready",
    error: null,
  } as Partial<ReturnType<typeof useAccountsStore.getState>>);
});

afterEach(() => {
  cleanup();
});

async function openMenu() {
  // Radix's DropdownMenu opens on pointerDown, not click — fireEvent.click
  // alone doesn't dispatch the pointer sequence happy-dom needs to flip
  // the Radix state. Send the pair explicitly. (This mirrors what
  // @testing-library/user-event does under the hood for pointer-driven
  // overlays.)
  const trigger = await screen.findByRole("button", { name: /test\.user/ });
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.pointerUp(trigger, { button: 0 });
  fireEvent.click(trigger);
  // Wait one microtask for Radix to render the portaled menu content.
  await Promise.resolve();
}

describe("AccountSwitcher — Admin Settings entry (X1A-46)", () => {
  it("shows the Admin Settings entry when isPlatformAdmin is true", async () => {
    setAuth({ isPlatformAdmin: true });
    render(<AccountSwitcher />);
    await openMenu();
    const link = screen.getByTestId("admin-settings-link") as HTMLAnchorElement;
    expect(link).toBeDefined();
    // Routes to /admin/settings — the page Astro renders the React root.
    expect(link.getAttribute("href")).toBe("/admin/settings");
    // NEW badge present so first-time admins notice the entry.
    expect(link.textContent?.toLowerCase()).toContain("new");
  });

  it("hides the Admin Settings entry when isPlatformAdmin is false", async () => {
    setAuth({ isPlatformAdmin: false });
    render(<AccountSwitcher />);
    await openMenu();
    expect(screen.queryByTestId("admin-settings-link")).toBeNull();
    // Sign out is still present — verifies the menu structure is intact
    // for non-admins (no accidental whole-menu disappearance).
    expect(screen.getByText(/sign out/i)).toBeDefined();
  });

  it("renders Admin Settings ABOVE Sign out (matches the greenlit mockup ordering)", async () => {
    setAuth({ isPlatformAdmin: true });
    render(<AccountSwitcher />);
    await openMenu();
    const admin = screen.getByTestId("admin-settings-link");
    const signOut = screen.getByText(/sign out/i);
    // DOM order: Admin Settings precedes Sign out. compareDocumentPosition
    // returns the bitmask DOCUMENT_POSITION_FOLLOWING (=4) when the arg
    // is positioned AFTER the receiver.
    const pos = admin.compareDocumentPosition(signOut);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
