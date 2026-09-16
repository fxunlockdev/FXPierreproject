import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN, E2E_SPACE, e2eEnv, freshEmail, signIn, signUp } from "./helpers";

test.describe("authentication", () => {
  test("wrong password is rejected with a visible error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(E2E_ADMIN.email);
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // filter: Next's empty route-announcer div also has role="alert"
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
  });

  test("signing in lands on the overview with live relay status", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText(/relay (online|stale|offline)/i).first()).toBeVisible();
    await expect(page.getByText(E2E_SPACE).first()).toBeVisible();
  });

  test("visiting a protected page while signed out redirects to login", async ({ page }) => {
    await page.goto("/activity");
    await page.waitForURL("**/login**");
  });
});

test.describe.serial("sign-up and private spaces", () => {
  // a failure mid-test must not leave sign-ups closed for every later spec
  test.afterAll(async () => {
    const env = e2eEnv();
    const db = createClient(env.apiUrl, env.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await db.from("platform_settings").update({ signups_open: true }).eq("id", 1);
  });

  test("anyone can sign up and lands in their own blank space", async ({ page }) => {
    await signUp(page, freshEmail("solo"), { spaceName: "Solo Signals" });
    await page.waitForURL("**/overview");
    await expect(page.getByRole("heading", { name: "Welcome to Solo Signals" })).toBeVisible();
    await expect(page.getByText("Connect your bot")).toBeVisible();
    // blank: none of the admin's space leaks in
    await expect(page.getByText(E2E_SPACE)).toHaveCount(0);
    // not the platform operator
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
  });

  test("the platform admin can close sign-ups, which blocks new accounts", async ({ page, browser }) => {
    await signIn(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Solo Signals/ })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Open sign-ups" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(page.getByText("Sign-ups are closed", { exact: true })).toBeVisible();

    const stranger = await browser.newPage();
    await stranger.goto("/login");
    await stranger.getByRole("button", { name: /create an account/i }).click();
    await expect(stranger.getByText(/new sign-ups are closed/i)).toBeVisible();
    await expect(stranger.getByLabel("Invite code")).toBeVisible();
    await expect(stranger.getByLabel("Space name")).toHaveCount(0);
    await stranger.close();

    // the database refuses too, whatever the form does
    const env = e2eEnv();
    const anon = createClient(env.apiUrl, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const direct = await anon.auth.signUp({ email: freshEmail("bypass"), password: "e2e-Bypass!pass1" });
    expect(direct.error).not.toBeNull();

    await toggle.click();
    await expect(page.getByText("Sign-ups are open", { exact: true })).toBeVisible();
  });

  test("a non-admin cannot open the admin page", async ({ page }) => {
    await signUp(page, freshEmail("nosy"));
    await page.waitForURL("**/overview");
    await page.goto("/admin");
    await page.waitForURL("**/overview");
  });

  test("an invite code brings a teammate into the same space as a viewer", async ({ page, browser }) => {
    await signIn(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Create code" }).click();
    const code = (await page.getByTestId("invite-code").textContent())?.trim() ?? "";
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const mate = await browser.newPage();
    const mateEmail = freshEmail("mate");
    await signUp(mate, mateEmail, { inviteCode: code });
    await mate.waitForURL("**/overview");
    await expect(mate.getByText(E2E_SPACE).first()).toBeVisible();
    await expect(mate.getByText(/viewer · read-only/i).first()).toBeVisible();

    // the code is single-use
    const late = await browser.newPage();
    await signUp(late, freshEmail("late"), { inviteCode: code });
    await expect(late.getByRole("alert").filter({ hasText: /\S/ })).toContainText(/invalid or has expired/i);
    await late.close();
    await mate.close();

    await page.reload();
    await expect(page.getByText(mateEmail)).toBeVisible();
  });
});
