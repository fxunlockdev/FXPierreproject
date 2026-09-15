"use client";

/** Calls the relay worker's admin API through the authenticated server proxy. */
export async function workerCall<T = Record<string, unknown>>(
  path: string,
  body?: Record<string, unknown>,
  method: "GET" | "POST" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const res = await fetch(`/api/worker/${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `worker request failed (${res.status})`);
  }
  return data;
}
