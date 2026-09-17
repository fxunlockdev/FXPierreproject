import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { e2eEnv, pickOption, signIn } from "./helpers";

/**
 * A group with topics whose topics were created before the bot joined: the
 * relay has never seen a message in them, so they must be addable by link.
 */

const FORUM = "Sim forum_desk";

function serviceDb() {
  const env = e2eEnv();
  return createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe.serial("forum topics", () => {
  test("add a group with topics as a receiver", async ({ page }) => {
    await signIn(page);
    await page.goto("/channels");
    await page.getByRole("button", { name: "Add channel" }).click();
    await pickOption(page, page.getByRole("combobox").first(), /Receiver/);
    await page.getByLabel("Username or link", { exact: true }).fill("@forum_desk");
    await page.getByRole("button", { name: "Add channel" }).last().click();
    await expect(page.getByText(`Added "${FORUM}"`)).toBeVisible();
  });

  test("a quiet topic is added from its link and becomes the route's target", async ({ page }) => {
    await signIn(page);
    await page.goto("/routes");
    await pickOption(page, page.getByRole("combobox", { name: "Receiver to link" }), FORUM);

    const into = page.getByRole("combobox", { name: "Post into topic" });
    await expect(into).toContainText("Into: General");

    await page.getByRole("button", { name: "Add topic" }).click();
    await page.getByLabel("Topic link").fill("https://t.me/forum_desk/7");
    await page.getByLabel("Topic name").fill("GOLD Scalp");
    await page.getByRole("button", { name: "Add topic" }).last().click();

    await expect(page.getByText("Topic “GOLD Scalp” added")).toBeVisible();
    await expect(into).toContainText("Into: GOLD Scalp");

    await page.getByRole("button", { name: "Link receiver" }).click();
    await expect(page.getByText("Receiver linked — forwarding is live")).toBeVisible();

    const { data: forum } = await serviceDb().from("channels").select("id").eq("title", FORUM).single();
    const { data: routes } = await serviceDb()
      .from("routes")
      .select("target_topic_id")
      .eq("receiver_id", forum!.id);
    expect(routes?.map((r) => r.target_topic_id)).toContain(7);
  });

  test("a link from another chat or a missing topic is refused with a reason", async ({ page }) => {
    await signIn(page);
    await page.goto("/routes");
    await pickOption(page, page.getByRole("combobox", { name: "Receiver to link" }), FORUM);

    await page.getByRole("button", { name: "Add topic" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Topic link").fill("https://t.me/c/1234567890/5");
    await dialog.getByRole("button", { name: "Add topic" }).click();
    await expect(dialog.getByRole("alert")).toContainText(`different chat, not ${FORUM}`);

    await dialog.getByLabel("Topic link").fill("https://t.me/forum_desk/404");
    await dialog.getByRole("button", { name: "Add topic" }).click();
    await expect(dialog.getByRole("alert")).toContainText("no topic with that link");
  });
});
