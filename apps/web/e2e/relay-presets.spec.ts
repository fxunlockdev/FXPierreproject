import { expect, test } from "@playwright/test";
import { signIn, workerSim } from "./helpers";

/**
 * One set of rules, written once and applied to routes — and the blocklist
 * box must keep the lines exactly as typed.
 */

const PRESET = "House rules";

test.describe.serial("rule presets", () => {
  test("a blocklist can be typed over several lines and saved as a preset", async ({ page }) => {
    await signIn(page);
    await page.goto("/presets");

    await page.getByLabel("New preset").fill(PRESET);
    await page.getByRole("button", { name: "Create preset" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Preset: ${PRESET}`);

    // typed, not pasted: pressing Enter must leave the line break in place
    const blocked = dialog.getByLabel("Must NOT contain (one per line)");
    await blocked.click();
    await page.keyboard.type("promo");
    await page.keyboard.press("Enter");
    await page.keyboard.type("sign up");
    await page.keyboard.press("Enter");
    await page.keyboard.type("free vip");
    await expect(blocked).toHaveValue("promo\nsign up\nfree vip");

    await dialog.getByRole("button", { name: "Save preset" }).click();
    await expect(page.getByText(/Preset saved/)).toBeVisible();
    await expect(page.getByText(/3 blocked/)).toBeVisible();
  });

  test("applying it to a route blocks matching posts and lets the rest through", async ({ page, request }) => {
    await signIn(page);
    await page.goto("/presets");

    await page.getByRole("button", { name: "Apply to routes" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").first().check();
    await dialog.getByRole("button", { name: /Apply to 1 route/ }).click();
    await expect(page.getByText(/now applies to 1 route/)).toBeVisible();
    await expect(page.getByText(/used by 1 route/)).toBeVisible();

    await page.goto("/activity");
    await workerSim(request, "sim/post", { text: "join now, sign up for free VIP" });
    const dropped = page.locator("tr", { hasText: "sign up for free VIP" }).first();
    await expect(dropped).toBeVisible({ timeout: 20_000 });
    await expect(dropped.getByText("dropped")).toBeVisible();

    await workerSim(request, "sim/post", { text: "buy gold at 2650" });
    const sent = page.locator("tr", { hasText: "gold at 2650" }).first();
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(sent.getByText("done")).toBeVisible({ timeout: 20_000 });
  });

  test("the route shows the preset's rules read-only, and can take its own back", async ({ page }) => {
    await signIn(page);
    await page.goto("/routes");

    const row = page.locator("li", { hasText: "Sim vip_room" }).first();
    await row.hover();
    await row.getByLabel(/^Edit route to/).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "Filters" }).click();
    await expect(dialog.getByRole("combobox", { name: "Rules preset" })).toContainText(PRESET);
    const blocked = dialog.getByLabel("Must NOT contain (one per line)");
    await expect(blocked).toHaveValue("promo\nsign up\nfree vip");
    await expect(blocked).toBeDisabled();

    await dialog.getByRole("button", { name: /Use my own rules instead/ }).click();
    await expect(blocked).toBeEnabled();
    await expect(blocked).toHaveValue("promo\nsign up\nfree vip"); // kept as a starting point
  });
});
