"use client";

import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Realtime → react-query bridge: DB changes invalidate the matching caches. */
function RealtimeBridge() {
  const qc = useQueryClient();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const sb = supabaseBrowser();
    const invalidate = (key: string) => {
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
        key,
        // 1s debounce: forwards mutate several times per message under load,
        // and every open tab refetches on invalidation — don't storm the API.
        setTimeout(() => void qc.invalidateQueries({ queryKey: [key] }), 1000),
      );
    };

    const tableToKey: Record<string, string> = {
      forwards: "forwards",
      incidents: "incidents",
      notifications: "notifications",
      worker_status: "worker_status",
      channels: "channels",
      routes: "routes",
      telegram_accounts: "accounts",
    };

    let channel = sb.channel("dashboard-live");
    for (const [table, key] of Object.entries(tableToKey)) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => invalidate(key),
      );
    }
    channel.subscribe();

    const timersMap = timers.current;
    return () => {
      void sb.removeChannel(channel);
      for (const t of timersMap.values()) clearTimeout(t);
      timersMap.clear();
    };
  }, [qc]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: true },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <RealtimeBridge />
      {children}
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--raised)",
            border: "1px solid var(--edge)",
            color: "var(--ink)",
          },
        }}
      />
    </QueryClientProvider>
  );
}
