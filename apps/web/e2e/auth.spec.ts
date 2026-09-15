import { expect, test } from "@playwright/test";
import { E2E_ADMIN, E2E_INVITEE, signIn } from "./helpers";

test.describe("authentication", () => {
  test("rejects an email that was never invited", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /activate your invite/i }).click();
    await page.getByLabel("Email").fill("stranger@nowhere.test");
    await page.getByLabel("Password").fill("some-Password!123");
    await page.getByRole("button", { name: /create password/i }).click();
    // filter: Next's empty route-announcer div also has role="alert"
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toContainText(/not been invited/i);
  });

  test("an invited member can activate and reach the dashboard", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /activate your invite/i }).click();
    await page.getByLabel("Email").fill(E2E_INVITEE.email);
    await page.getByLabel("Password").fill(E2E_INVITEE.password);
    await page.getByRole("button", { name: /create password/i }).click();
    await page.waitForURL("**/overview");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  test("wrong password is rejected with a visible error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_ADMIN.email);
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  });

  test("signing in lands on the overview with live relay status", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText(/relay (online|stale|offline)/i).first()).toBeVisible();
  });

  test("visiting a protected page while signed out redirects to login", async ({ page }) => {
    await page.goto("/activity");
    await page.waitForURL("**/login**");
  });
});
