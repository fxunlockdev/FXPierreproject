import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { e2eEnv, pickOption, signIn, workerSim } from "./helpers";

/**
 * The core product journey, end to end against the simulated Telegram:
 * add channels → link a route → configure rules → a "post" flows through the
 * worker → appears live in the activity log, transformed → toggles apply
 * instantly → failures open incidents and can be retried.
 */

const MASTER_NAME = "Sim gold_signals";
const RECEIVER_NAME = "Sim vip_room";

function serviceDb() {
  const env = e2eEnv();
  return createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe.serial("relay flow", () => {
  test("add a master and a receiver channel", async ({ page }) => {
    await signIn(page);
    await page.goto("/channels");

    // master
    await page.getByRole("button", { name: "Add channel" }).click();
    await page.getByLabel("Username or link", { exact: true }).fill("@gold_signals");
    await page.getByRole("button", { name: "Add channel" }).last().click();
    await expect(page.getByText(`Added "${MASTER_NAME}"`)).toBeVisible();
    await expect(page.getByText(MASTER_NAME).first()).toBeVisible();

    // receiver
    await page.getByRole("button", { name: "Add channel" }).click();
    await pickOption(page, page.getByRole("combobox").first(), /Receiver/);
    await page.getByLabel("Username or link", { exact: true }).fill("@vip_room");
    await page.getByRole("button", { name: "Add channel" }).last().click();
    await expect(page.getByText(`Added "${RECEIVER_NAME}"`)).toBeVisible();
  });

  test("flags a protected master with a warning", async ({ page }) => {
    await signIn(page);
    await page.goto("/channels");
    await page.getByRole("button", { name: "Add channel" }).click();
    await page.getByLabel("Username or link", { exact: true }).fill("@protected_source");
    await page.getByRole("button", { name: "Add channel" }).last().click();
    await expect(page.getByText(/protected content and cannot be relayed/i)).toBeVisible();
    await expect(page.getByText(/Restrict saving content/i)).toBeVisible();
  });

  test("link the receiver and configure transforms", async ({ page }) => {
    await signIn(page);
    await page.goto("/routes");

    await expect(page.getByRole("button", { name: new RegExp(MASTER_NAME) })).toBeVisible();
    await pickOption(page, page.getByRole("combobox"), RECEIVER_NAME);
    await page.getByRole("button", { name: "Link receiver" }).click();
    await expect(page.getByText("Receiver linked — forwarding is live")).toBeVisible();

    // open the editor and add a replacement + footer
    const row = page.locator("li", { hasText: RECEIVER_NAME }).first();
    await row.hover();
    await row.getByLabel(`Edit route to ${RECEIVER_NAME}`).click();

    await page.getByRole("tab", { name: "Transforms" }).click();
    await page.getByRole("button", { name: "Add replacement" }).click();
    await page.getByPlaceholder("find").fill("buy");
    await page.getByPlaceholder("replace with").fill("LONG");
    await page.getByLabel("Footer").fill("via {master}");

    // live preview in the Test tab proves the pipeline before saving
    await page.getByRole("tab", { name: "Test" }).click();
    await page.getByLabel("Paste a sample message").fill("buy gold at 2650");
    await expect(page.getByText("passes")).toBeVisible();
    await expect(page.getByText("LONG gold at 2650")).toBeVisible();
    await expect(page.getByText(`via ${MASTER_NAME}`)).toBeVisible();

    await page.getByRole("button", { name: "Save route" }).click();
    await expect(page.getByText("Route saved — live immediately")).toBeVisible();
  });

  test("a simulated post flows through and lands transformed in the activity log", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto("/activity");

    await workerSim(request, "sim/post", { text: "buy gold now, TP 2700" });

    const row = page.locator("tr", { hasText: "LONG gold now" }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("done")).toBeVisible();

    // detail drawer shows the full transformed preview incl. the footer
    await row.click();
    await expect(page.getByText(`via ${MASTER_NAME}`).first()).toBeVisible();
  });

  test("an edit on the master is replayed to the receiver", async ({ page, request }) => {
    await signIn(page);
    const posted = await workerSim(request, "sim/post", { text: "buy entry 1.0850" });

    await page.goto("/activity");
    const postRow = page.locator("tr", { hasText: "LONG entry 1.0850" }).first();
    await expect(postRow).toBeVisible({ timeout: 20_000 });
    // wait until delivered — an edit against a still-queued post is applied
    // in place instead of creating an edit forward
    await expect(postRow.getByText("done")).toBeVisible({ timeout: 20_000 });

    await workerSim(request, "sim/edit", {
      chatTgId: posted.chatTgId,
      messageId: posted.messageId,
      text: "buy entry 1.0900 updated",
    });

    const editRow = page.locator("tr", { hasText: "LONG entry 1.0900 updated" }).first();
    await expect(editRow).toBeVisible({ timeout: 20_000 });
    await expect(editRow.getByText("edit")).toBeVisible();
  });

  test("toggling a route off stops forwarding instantly, on resumes it", async ({
    page,
    request,
  }) => {
    await signIn(page);
    await page.goto("/routes");

    const toggle = page.getByRole("switch", { name: `Route to ${RECEIVER_NAME}` });
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    await page.waitForTimeout(1500); // let the worker pick up the config change

    await workerSim(request, "sim/post", { text: "buy while paused" });
    await page.waitForTimeout(4000);

    const db = serviceDb();
    const { data: paused } = await db.from("forwards").select("id").ilike("preview", "%while paused%");
    expect(paused ?? []).toHaveLength(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "checked");
    await page.waitForTimeout(1500);

    await workerSim(request, "sim/post", { text: "buy after resume" });
    await page.goto("/activity");
    await expect(page.locator("tr", { hasText: "LONG after resume" }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test("delivery failures open an incident, auto-pause the route, and can be retried", async ({
    page,
    request,
  }) => {
    await signIn(page);
    const db = serviceDb();
    const { data: receiver } = await db
      .from("channels")
      .select("tg_chat_id")
      .eq("role", "receiver")
      .not("tg_chat_id", "is", null)
      .limit(1)
      .single();
    const receiverTg = String(receiver!.tg_chat_id);

    await workerSim(request, "sim/fail", { chatTgId: receiverTg, code: "forbidden" });
    await workerSim(request, "sim/post", { text: "fail one" });
    await workerSim(request, "sim/post", { text: "fail two" });
    await workerSim(request, "sim/post", { text: "fail three" });

    await page.goto("/alerts");
    // scope to the incidents section — the Delivery settings below list the
    // same labels as trigger names, which must never satisfy this assertion
    const incidents = page.locator("section").filter({ hasText: "Open incidents" });
    await expect(incidents.getByText("Receiver unreachable").first()).toBeVisible({ timeout: 25_000 });
    await expect(incidents.getByText("Route auto-paused").first()).toBeVisible({ timeout: 25_000 });

    // stop failing, re-enable the route, retry the failed forward from the UI
    await workerSim(request, "sim/fail", { chatTgId: receiverTg, code: "off" });
    await page.goto("/routes");
    const toggle = page.getByRole("switch", { name: `Route to ${RECEIVER_NAME}` });
    await expect(toggle).toHaveAttribute("data-state", "unchecked", { timeout: 15_000 });
    await toggle.click();
    await page.waitForTimeout(1500);

    await page.goto("/activity");
    const failedRow = page.locator("tr", { hasText: "fail one" }).first();
    await expect(failedRow).toBeVisible();
    await failedRow.click();
    await page.getByRole("button", { name: "Retry now" }).click();
    await expect(page.getByText("Queued for retry")).toBeVisible();
    await expect(
      page.locator("tr", { hasText: "fail one" }).first().getByText("done"),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("overview reflects the traffic", async ({ page }) => {
    await signIn(page);
    await expect(page.getByText("Forwards today")).toBeVisible();
    const value = page
      .getByText("Forwards today", { exact: true })
      .locator("xpath=following-sibling::span[1]");
    await expect(value).not.toHaveText("0");
  });
});
