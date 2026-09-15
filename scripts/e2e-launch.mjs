// Launches the web app or the worker with the generated .env.e2e file.
// Usage: node scripts/e2e-launch.mjs web|worker
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

const configs = {
  web: {
    cwd: join(root, "apps/web"),
    envFile: join(root, "apps/web/.env.e2e"),
    command: ["pnpm", "exec", "next", "dev", "-p", "3100"],
  },
  worker: {
    cwd: join(root, "apps/worker"),
    envFile: join(root, "apps/worker/.env.e2e"),
    command: ["pnpm", "exec", "tsx", "src/index.ts"],
  },
};

const config = configs[target];
if (!config) {
  console.error("usage: node scripts/e2e-launch.mjs web|worker");
  process.exit(1);
}

const envPairs = Object.fromEntries(
  readFileSync(config.envFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

// .env.local must NOT leak into e2e runs — Next.js loads it automatically,
// so we override every key explicitly via real process env (which wins).
const child = spawn(config.command[0], config.command.slice(1), {
  cwd: config.cwd,
  env: { ...process.env, ...envPairs },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
