// Prepares the e2e environment: resolves local Supabase credentials, writes
// .env.e2e files, resets relay data, and provisions the test users.
// Runs BEFORE playwright (via the test:e2e script) so ordering is guaranteed.
import { createClient } from "@supabase/supabase-js";
import { resolveE2eEnv, writeEnvFiles } from "../../../scripts/e2e-env.mjs";

export const E2E_ADMIN = { email: "e2e@switchyard.test", password: "e2e-Sw1tchyard!pass" };
export const E2E_INVITEE = { email: "activate2@switchyard.test", password: "e2e-Act1vate!pass" };

async function main() {
  const env = resolveE2eEnv();
  writeEnvFiles(env);

  const admin = createClient(env.apiUrl, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // invite both test members (idempotent)
  for (const [email, role] of [
    [E2E_ADMIN.email, "admin"],
    [E2E_INVITEE.email, "admin"],
  ]) {
    const { error } = await admin
      .from("app_members")
      .upsert({ email, role }, { onConflict: "email" });
    if (error) throw new Error(`seed member ${email}: ${error.message}`);
  }

  // reset relay data so every run starts clean
  for (const table of ["forwards", "routes", "channels", "incidents", "notifications", "worker_status", "audit_log"]) {
    const { error } = await admin.from(table).delete().gte("created_at", "1970-01-01").select("*").limit(0);
    if (error && !/column .* does not exist/.test(error.message)) {
      // worker_status has no created_at — fall back to instance filter
      const fallback = await admin.from(table).delete().neq("instance_id", "");
      if (fallback.error) throw new Error(`reset ${table}: ${error.message}`);
    }
  }

  // provision the signed-in admin (confirmed), and make sure the "activate me"
  // user does NOT exist yet so the invite-activation flow can be tested
  const { data: usersPage, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw new Error(`list users: ${listErr.message}`);
  const users = usersPage?.users ?? [];

  if (!users.some((u) => u.email === E2E_ADMIN.email)) {
    const { error } = await admin.auth.admin.createUser({
      email: E2E_ADMIN.email,
      password: E2E_ADMIN.password,
      email_confirm: true,
    });
    if (error) throw new Error(`create admin user: ${error.message}`);
  }

  const stale = users.find((u) => u.email === E2E_INVITEE.email);
  if (stale) {
    const { error } = await admin.auth.admin.deleteUser(stale.id);
    if (error) throw new Error(`reset invitee: ${error.message}`);
    await admin.from("app_members").update({ user_id: null }).eq("email", E2E_INVITEE.email);
  }

  console.log("[e2e] environment ready:", env.apiUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
