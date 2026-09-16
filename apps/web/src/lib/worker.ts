"use client";

/**
 * The space every worker call acts in. Set by SpaceProvider; module state is
 * per browser tab, so two tabs on two spaces never mix their actions.
 */
let currentSpaceId: string | null = null;

export function setWorkerSpace(spaceId: string): void {
  currentSpaceId = spaceId;
}

/** Calls the relay worker's admin API through the authenticated server proxy. */
export async function workerCall<T = Record<string, unknown>>(
  path: string,
  body?: Record<string, unknown>,
  method: "GET" | "POST" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (currentSpaceId) headers["x-space-id"] = currentSpaceId;

  const res = await fetch(`/api/worker/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `worker request failed (${res.status})`);
  }
  return data;
}
