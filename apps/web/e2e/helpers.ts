import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const E2E_ADMIN = { email: "e2e@switchyard.test", password: "e2e-Sw1tchyard!pass" };
export const E2E_INVITEE = { email: "activate2@switchyard.test", password: "e2e-Act1vate!pass" };

interface E2eEnv {
  apiUrl: string;
  anonKey: string;
  serviceKey: string;
  workerToken: string;
}

export function e2eEnv(): E2eEnv {
  const raw = readFileSync(join(__dirname, "../../../.e2e-env.json"), "utf8");
  return JSON.parse(raw) as E2eEnv;
}

export async function signIn(page: Page, email = E2E_ADMIN.email, password = E2E_ADMIN.password) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/overview");
}

/** Talk to the worker's sim API directly (same thing the relay does live). */
export async function workerSim(
  request: APIRequestContext,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { workerToken } = e2eEnv();
  const res = await request.post(`http://127.0.0.1:8788/${path}`, {
    headers: { authorization: `Bearer ${workerToken}` },
    data: body,
  });
  expect(res.ok(), `${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as Record<string, unknown>;
}

/** Radix Select helper: open the trigger inside a labeled field and pick an option. */
export async function pickOption(page: Page, trigger: ReturnType<Page["locator"]>, optionText: string | RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}
