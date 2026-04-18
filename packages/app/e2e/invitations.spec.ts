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
  test("dev bypass lands on the default workspace and shows the user", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);
    await page.goto("/workspaces/default");
    await expect(
      page.getByRole("heading", { name: "Default" }),
    ).toBeVisible();
    await expect(page.getByText("role: owner")).toBeVisible();
  });
});

test.describe("invitations", () => {
  test("admin can create an invitation from the workspace panel", async ({
    context,
    page,
  }) => {
    await devBypassSignIn(context);
    await page.goto("/workspaces/default");

    const email = `invitee-${Date.now()}@example.com`;
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send invite" }).click();

    await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator("li", { hasText: email }).getByText(/pending/),
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
