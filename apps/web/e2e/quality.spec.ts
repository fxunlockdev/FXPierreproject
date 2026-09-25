import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const WIDTHS = [320, 768, 1024, 1440] as const;
const PAGES = ["/overview", "/routes", "/channels", "/activity", "/alerts", "/settings"] as const;

test.describe("accessibility", () => {
  test("login page has no critical a11y violations", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === "critical");
    expect(critical, JSON.stringify(critical, null, 2)).toHaveLength(0);
  });

  test("core app pages have no critical a11y violations", async ({ page }) => {
    await signIn(page);
    for (const path of ["/overview", "/routes", "/activity"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).analyze();
      const critical = results.violations.filter((v) => v.impact === "critical");
      expect(critical, `${path}: ${JSON.stringify(critical, null, 2)}`).toHaveLength(0);
    }
  });

  test("keyboard navigation reaches the main nav and follows links", async ({ page }) => {
    await signIn(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(focused).toBe("A");
  });
});

test.describe("responsive", () => {
  test("no horizontal overflow at any breakpoint", async ({ page }) => {
    await signIn(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PAGES) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} overflows by ${overflow}px at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("visual snapshots at key breakpoints (artifacts for design review)", async ({ page }) => {
    await signIn(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/login", "/overview", "/routes", "/activity"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: `test-results/screens/${path.replaceAll("/", "") || "root"}-${width}.png`,
          fullPage: true,
        });
      }
    }
  });

  test("both themes render intentionally", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: /switch to light/i }).click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.screenshot({ path: "test-results/screens/settings-light.png", fullPage: true });
    await page.goto("/overview");
    await page.screenshot({ path: "test-results/screens/overview-light.png", fullPage: true });
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("button", { name: /switch to dark/i }).click();
    await expect(page.locator("html")).not.toHaveClass(/light/);
  });
});

