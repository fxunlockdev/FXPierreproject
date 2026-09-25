import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * An iPad never hovers. Controls revealed by hover alone are unreachable
 * there — which once hid the route editor, and with it every filter.
 */
test.describe("touch devices", () => {
  test.use({ viewport: { width: 1080, height: 810 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("route actions are reachable without hovering", async ({ page }) => {
    await signIn(page);
    await page.goto("/routes");

    const edit = page.getByLabel(/^Edit route to/).first();
    await expect(edit).toBeVisible();
    await expect(edit).not.toHaveCSS("opacity", "0");

    await edit.tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Changes apply instantly");
    await dialog.getByRole("tab", { name: "Filters" }).tap();
    await expect(dialog.getByLabel("Must NOT contain (one per line)")).toBeVisible();
  });
});
