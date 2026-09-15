// Resolves local Supabase credentials and writes .env.e2e files for the
// dashboard and the worker. Called from Playwright's global setup.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stampPath = join(root, ".e2e-env.json");

export function resolveE2eEnv() {
  if (existsSync(stampPath)) {
    try {
      const cached = JSON.parse(readFileSync(stampPath, "utf8"));
      if (cached.apiUrl && cached.serviceKey && cached.anonKey) return cached;
    } catch {
      // fall through to re-resolve
    }
  }

  let output;
  try {
    output = execSync("pnpm dlx supabase status -o env", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "Local Supabase is not running. Start it with: pnpm dlx supabase start\n" +
        String(err?.message ?? err),
    );
  }

  const get = (key) => {
    const m = new RegExp(`${key}="?([^"\n]+)"?`).exec(output);
    return m?.[1];
  };

  const env = {
    apiUrl: get("API_URL") ?? "http://127.0.0.1:54321",
    anonKey: get("ANON_KEY"),
    serviceKey: get("SERVICE_ROLE_KEY"),
    workerToken: randomBytes(24).toString("hex"),
    encryptionKey: randomBytes(24).toString("hex"),
  };
  if (!env.anonKey || !env.serviceKey) {
    throw new Error(`Could not parse supabase status output:\n${output}`);
  }

  writeFileSync(stampPath, JSON.stringify(env, null, 2));
  return env;
}

export function writeEnvFiles(env) {
  writeFileSync(
    join(root, "apps/web/.env.e2e"),
    [
      `NEXT_PUBLIC_SUPABASE_URL=${env.apiUrl}`,
      `NEXT_PUBLIC_SUPABASE_ANON_KEY=${env.anonKey}`,
      `WORKER_URL=http://127.0.0.1:8788`,
      `WORKER_API_TOKEN=${env.workerToken}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "apps/worker/.env.e2e"),
    [
      `SUPABASE_URL=${env.apiUrl}`,
      `SUPABASE_SERVICE_ROLE_KEY=${env.serviceKey}`,
      `SESSION_ENCRYPTION_KEY=${env.encryptionKey}`,
      `WORKER_API_TOKEN=${env.workerToken}`,
      `PORT=8788`,
      `SIMULATE=1`,
      `CONFIG_POLL_SECONDS=2`,
      "",
    ].join("\n"),
  );
}
