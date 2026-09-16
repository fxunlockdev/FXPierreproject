// Prepares the e2e environment: resolves local Supabase credentials, writes
// .env.e2e files, resets relay data, and provisions the test users.
// Runs BEFORE playwright (via the test:e2e script) so ordering is guaranteed.
import { createClient } from "@supabase/supabase-js";
import { resolveE2eEnv, writeEnvFiles } from "../../../scripts/e2e-env.mjs";

export const E2E_ADMIN = { email: "e2e@switchyard.test", password: "e2e-Sw1tchyard!pass" };
export const E2E_SPACE = "E2E Desk";

async function main() {
  const env = resolveE2eEnv();
  // this script deletes every user and space — never point it at a real project
  const host = new URL(env.apiUrl).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`refusing to reset a non-local Supabase (${host})`);
  }
  writeEnvFiles(env);

  const admin = createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // every run starts from zero: no users, no spaces (space rows cascade to
  // all relay data), open sign-ups, no stale heartbeat
  const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new Error(`list users: ${listErr.message}`);
  for (const u of usersPage?.users ?? []) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`delete user ${u.email}: ${error.message}`);
  }
  const spaces = await admin.from("spaces").delete().not("id", "is", null);
  if (spaces.error) throw new Error(`reset spaces: ${spaces.error.message}`);
  const ws = await admin.from("worker_status").delete().neq("instance_id", "");
  if (ws.error) throw new Error(`reset worker_status: ${ws.error.message}`);
  const settings = await admin.from("platform_settings").update({ signups_open: true }).eq("id", 1);
  if (settings.error) throw new Error(`open sign-ups: ${settings.error.message}`);

  // the admin signs up like anyone else (the trigger gives them a space),
  // then becomes the platform operator
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: E2E_ADMIN.email,
    password: E2E_ADMIN.password,
    email_confirm: true,
    user_metadata: { space_name: E2E_SPACE },
  });
  if (createErr) throw new Error(`create admin user: ${createErr.message}`);
  const grant = await admin.from("platform_admins").insert({ user_id: created.user.id });
  if (grant.error) throw new Error(`grant platform admin: ${grant.error.message}`);

  console.log("[e2e] environment ready:", env.apiUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
