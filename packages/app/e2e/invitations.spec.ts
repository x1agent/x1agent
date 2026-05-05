import { test, expect, type BrowserContext } from "@playwright/test";

const API_URL = process.env.API_PUBLIC_URL || "http://localhost:30001";

/**
 * Dev bypass login: hits the API endpoint that short-circuits OAuth and
 * sets the session cookie. The context persists it for the rest of the
 * test, same as a browser would.
 */
async function devBypassSignIn(context: BrowserContext) {
  const res = await context.request.get(`${API_URL}/auth/bypass`, {
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  expect(res.status()).toBe(302);
  // The redirect lands at /workspaces/{slug}. Cookie is already stored.
}

test.describe("sign in + workspace", () => {
  test("dev bypass lands on the workspace driver home with composer", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);
    await page.goto("/workspaces/default");
    // Driver home renders a time-aware greeting + the new session
    // composer. Greeting copy varies by time-of-day so match either
    // form. The composer's textarea has a stable placeholder.
    await expect(
      page.getByRole("heading", {
        name: /(Good (morning|afternoon|evening)|Up late),/,
      }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("What are you working on today?"),
    ).toBeVisible();
  });

  test("settings page shows the signed-in user's identity", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);
    await page.goto("/workspaces/default/settings");
    // Identity card was relocated from the workspace home to the
    // settings overview when the home was rebuilt as the driver page.
    await expect(
      page.getByRole("heading", { name: "Signed in as" }),
    ).toBeVisible();
    await expect(page.getByText(/role:\s*owner/i)).toBeVisible();
  });
});

test.describe("invitations", () => {
  test("admin can create an invitation from the members settings panel", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);
    // The invitations form moved out of the workspace home into the
    // settings IA's Members → People leaf.
    await page.goto("/workspaces/default/settings/members/people");

    const email = `invitee-${Date.now()}@example.com`;
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });
    // InvitationsPanel renders rows in a Table (post UI-sweep), so the
    // hasText scope is `tr`, not `li`.
    await expect(
      page.locator("tr", { hasText: email }).getByText(/pending/i),
    ).toBeVisible();
  });

  test("public invitation token page renders workspace + email", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);

    // Create the invite via the API, then visit the accept page anonymously.
    const email = `public-${Date.now()}@example.com`;
    const created = await context.request.post(
      `${API_URL}/api/workspaces/default/invitations`,
      { data: { email, role: "member" } },
    );
    expect(created.status()).toBe(201);
    const { invitation } = (await created.json()) as {
      invitation: { token: string };
    };

    // Separate anonymous context, no session cookie.
    const anon = await context.browser()!.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`/invite/${invitation.token}`);
    await expect(anonPage.getByText("Join Default")).toBeVisible();
    await expect(anonPage.getByText(email, { exact: false })).toBeVisible();
    await anon.close();
  });
});
