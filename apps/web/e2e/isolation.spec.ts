import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { E2E_SPACE, NEW_USER_PASSWORD, e2eEnv, freshEmail, signUp } from "./helpers";

/**
 * Hostile-tenant checks against the real stack: a signed-up stranger pokes at
 * the admin's space directly through the database API and the worker proxy.
 */

function serviceDb(): SupabaseClient {
  const env = e2eEnv();
  return createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function strangerDb(email: string): Promise<SupabaseClient> {
  const env = e2eEnv();
  const db = createClient(env.apiUrl, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.auth.signInWithPassword({ email, password: NEW_USER_PASSWORD });
  if (error) throw new Error(`stranger sign-in: ${error.message}`);
  return db;
}

async function victimSpaceId(): Promise<string> {
  const { data, error } = await serviceDb().from("spaces").select("id").eq("name", E2E_SPACE).single();
  if (error) throw new Error(`find admin space: ${error.message}`);
  return data.id as string;
}

test.describe.serial("space isolation", () => {
  const email = freshEmail("intruder");

  test("an intruder signs up into their own space", async ({ page }) => {
    await signUp(page, email, { spaceName: "Intruder HQ" });
    await page.waitForURL("**/overview");
  });

  test("cannot read, write or administer another space through the database API", async () => {
    const victim = await victimSpaceId();
    const db = await strangerDb(email);

    // plant a row in the victim space so "no rows" really means "hidden"
    const service = serviceDb();
    const planted = await service
      .from("channels")
      .insert({ space_id: victim, role: "master", title: "victim secret", username: "victim_secret_chan" })
      .select("id")
      .single();
    expect(planted.error).toBeNull();

    try {
      for (const table of ["channels", "routes", "forwards", "telegram_accounts", "alert_settings", "space_members"]) {
        const { data, error } = await db.from(table).select("*").eq("space_id", victim);
        expect(error, table).toBeNull();
        expect(data ?? [], table).toHaveLength(0);
      }

      const insert = await db
        .from("channels")
        .insert({ space_id: victim, role: "receiver", title: "smuggled" });
      expect(insert.error).not.toBeNull();

      const update = await db.from("channels").update({ title: "defaced" }).eq("id", planted.data!.id).select();
      expect(update.data ?? []).toHaveLength(0);

      for (const [fn, args] of [
        ["create_space_invite", { p_space: victim, p_role: "admin" }],
        ["rename_space", { p_space: victim, p_name: "pwned" }],
        ["admin_list_spaces", {}],
        ["admin_set_signups_open", { p_open: false }],
        ["admin_set_space_disabled", { p_space: victim, p_disabled: true }],
      ] as const) {
        const { error } = await db.rpc(fn, args);
        expect(error, fn).not.toBeNull();
      }

      const members = await db.rpc("space_member_list", { p_space: victim });
      expect(members.data ?? []).toHaveLength(0);

      const untouched = await service.from("channels").select("title").eq("id", planted.data!.id).single();
      expect(untouched.data?.title).toBe("victim secret");
    } finally {
      await service.from("channels").delete().eq("id", planted.data!.id);
    }
  });

  test("cannot drive the relay worker on behalf of another space", async ({ page }) => {
    const victim = await victimSpaceId();
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(NEW_USER_PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL("**/overview");

    const foreign = await page.request.post("/api/worker/alerts/test", {
      headers: { "x-space-id": victim },
      data: {},
    });
    expect(foreign.status()).toBe(403);

    const missing = await page.request.post("/api/worker/alerts/test", { data: {} });
    expect(missing.status()).toBe(400);
  });
});
