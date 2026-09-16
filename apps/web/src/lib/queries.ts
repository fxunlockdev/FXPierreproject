"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { findRouteRulesProblem, RouteScheduleSchema } from "@pierre/core";
import { useSpaceId } from "./space";
import { supabaseBrowser } from "./supabase/client";
import type {
  AccountRow,
  AdminSpaceRow,
  AlertSettingsRow,
  AppSettingsRow,
  AuditRow,
  ChannelRow,
  DiscoveredChatRow,
  ForumTopicRow,
  ForwardRow,
  IncidentRow,
  NotificationRow,
  RelayStatusRow,
  RouteRow,
  SpaceMemberRow,
  SpaceRole,
} from "./types";

const sb = () => supabaseBrowser();

/**
 * Rows of one space. Row-level security already hides other clients' spaces;
 * this filter picks the CURRENT space out of the ones the user belongs to.
 * Query keys start [table, space…] so invalidating [table] hits every space.
 */
async function selectInSpace<T>(
  table: string,
  space: string,
  order: string,
  ascending = false,
  limit = 1000,
): Promise<T[]> {
  const { data, error } = await sb()
    .from(table)
    .select("*")
    .eq("space_id", space)
    .order(order, { ascending })
    .limit(limit);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

// ── reads ──────────────────────────────────────────────────────────────────

export const useChannels = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["channels", space],
    queryFn: () => selectInSpace<ChannelRow>("channels", space, "created_at", true),
  });
};

export const useRoutes = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["routes", space],
    queryFn: () => selectInSpace<RouteRow>("routes", space, "created_at", true),
  });
};

export const useForumTopics = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["forum_topics", space],
    queryFn: () => selectInSpace<ForumTopicRow>("forum_topics", space, "last_seen_at", false, 1000),
  });
};

export const useDiscoveredChats = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["discovered_chats", space],
    queryFn: () => selectInSpace<DiscoveredChatRow>("discovered_chats", space, "last_seen_at", false, 500),
  });
};

export const useAccounts = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["accounts", space],
    queryFn: () => selectInSpace<AccountRow>("telegram_accounts", space, "created_at", true),
  });
};

/** Latest relay heartbeat — the relay is shared infrastructure, instances stay private. */
export const useRelayStatus = () =>
  useQuery({
    queryKey: ["relay_status"],
    queryFn: async () => {
      const { data, error } = await sb().rpc("relay_status");
      if (error) throw new Error(error.message);
      return ((data as RelayStatusRow[] | null) ?? [])[0] ?? null;
    },
    refetchInterval: 15_000,
  });

/** Forwards of this space still waiting to go out. */
export const usePendingCount = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["forwards", space, "pending"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const { count, error } = await sb()
        .from("forwards")
        .select("id", { count: "exact", head: true })
        .eq("space_id", space)
        .in("state", ["queued", "scheduled", "held", "sending"]);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });
};

export interface ForwardFilters {
  state?: string;
  kind?: string;
  routeId?: string;
}

export const useForwards = (filters: ForwardFilters = {}, limit = 200) => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["forwards", space, filters, limit],
    // realtime invalidation is the fast path; this poll is the floor so the
    // log still moves when the websocket is unavailable
    refetchInterval: 5_000,
    queryFn: async () => {
      let q = sb()
        .from("forwards")
        .select("*")
        .eq("space_id", space)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (filters.state) q = q.eq("state", filters.state);
      if (filters.kind) q = q.eq("kind", filters.kind);
      if (filters.routeId) q = q.eq("route_id", filters.routeId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ForwardRow[];
    },
  });
};

export const useForwardsToday = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["forwards", space, "today"],
    refetchInterval: 15_000,
    queryFn: async () => {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const { data, error } = await sb()
        .from("forwards")
        .select("id,state,kind,latency_ms,created_at,drop_reason")
        .eq("space_id", space)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      return (data ?? []) as Pick<ForwardRow, "id" | "state" | "kind" | "latency_ms" | "created_at" | "drop_reason">[];
    },
  });
};

export const useIncidents = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["incidents", space],
    refetchInterval: 15_000,
    queryFn: () => selectInSpace<IncidentRow>("incidents", space, "last_seen", false, 100),
  });
};

export const useNotifications = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["notifications", space],
    refetchInterval: 30_000,
    queryFn: () => selectInSpace<NotificationRow>("notifications", space, "created_at", false, 50),
  });
};

export const useAlertSettings = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["alert_settings", space],
    queryFn: async () => {
      const { data, error } = await sb().from("alert_settings").select("*").eq("space_id", space).single();
      if (error) throw new Error(error.message);
      return data as AlertSettingsRow;
    },
  });
};

export const useAppSettings = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["app_settings", space],
    queryFn: async () => {
      const { data, error } = await sb().from("app_settings").select("*").eq("space_id", space).single();
      if (error) throw new Error(error.message);
      return data as AppSettingsRow;
    },
  });
};

export const useMembers = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["members", space],
    queryFn: async () => {
      const { data, error } = await sb().rpc("space_member_list", { p_space: space });
      if (error) throw new Error(error.message);
      return (data ?? []) as SpaceMemberRow[];
    },
  });
};

export const useAudit = () => {
  const space = useSpaceId();
  return useQuery({
    queryKey: ["audit", space],
    queryFn: () => selectInSpace<AuditRow>("audit_log", space, "created_at", false, 80),
  });
};

export const useAdminSpaces = () =>
  useQuery({
    queryKey: ["admin_spaces"],
    queryFn: async () => {
      const { data, error } = await sb().rpc("admin_list_spaces");
      if (error) throw new Error(error.message);
      return (data ?? []) as AdminSpaceRow[];
    },
  });

export const useSignupsOpen = () =>
  useQuery({
    queryKey: ["signups_open"],
    queryFn: async () => {
      const { data, error } = await sb().rpc("admin_get_signups_open");
      if (error) throw new Error(error.message);
      return Boolean(data);
    },
  });

// ── writes ─────────────────────────────────────────────────────────────────

function useTableMutation<TInput, TResult = void>(
  fn: (input: TInput) => Promise<TResult>,
  invalidate: string[],
  errorPrefix: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (err) => toast.error(`${errorPrefix}: ${err.message}`),
  });
}

export function useInsertChannel() {
  const space = useSpaceId();
  return useTableMutation<Partial<ChannelRow> & { role: string }>(
    async (values) => {
      const { error } = await sb().from("channels").insert({ ...values, space_id: space });
      if (error) throw new Error(error.message);
    },
    ["channels"],
    "Could not add channel",
  );
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  const key = ["channels", useSpaceId()];
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ChannelRow> }) => {
      const { error } = await sb().from("channels").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ChannelRow[]>(key);
      qc.setQueryData<ChannelRow[]>(key, (old) =>
        (old ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toast.error(`Change reverted: ${err.message}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteChannel() {
  return useTableMutation<string>(
    async (id) => {
      const { error } = await sb().from("channels").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    ["channels", "routes"],
    "Could not remove channel",
  );
}

export function useInsertRoute() {
  // space_id is filled by the database from the master channel
  return useTableMutation<Partial<RouteRow> & { master_id: string; receiver_id: string }>(
    async (values) => {
      const { error } = await sb().from("routes").insert(values);
      if (error) throw new Error(error.message);
    },
    ["routes"],
    "Could not link receiver",
  );
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  const key = ["routes", useSpaceId()];
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<RouteRow> }) => {
      // Validate BEFORE writing — the worker treats invalid rules/schedules as
      // "off", so a bad row would silently change relay behavior.
      if ("rules" in patch) {
        const problem = findRouteRulesProblem(patch.rules);
        if (problem) throw new Error(problem);
      }
      if (patch.schedule !== null && patch.schedule !== undefined) {
        const parsed = RouteScheduleSchema.safeParse(patch.schedule);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(
            issue ? `schedule ${issue.path.join(".")}: ${issue.message}` : "invalid schedule",
          );
        }
      }
      const { error } = await sb().from("routes").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<RouteRow[]>(key);
      qc.setQueryData<RouteRow[]>(key, (old) =>
        (old ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toast.error(`Change reverted: ${err.message}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

export function useDeleteRoute() {
  return useTableMutation<string>(
    async (id) => {
      const { error } = await sb().from("routes").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    ["routes"],
    "Could not unlink",
  );
}

export function useUpdateAccount() {
  return useTableMutation<{ id: string; patch: Partial<AccountRow> }>(
    async ({ id, patch }) => {
      const { error } = await sb().from("telegram_accounts").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    ["accounts"],
    "Could not update account",
  );
}

export function useUpdateAlertSettings() {
  const space = useSpaceId();
  return useTableMutation<Partial<AlertSettingsRow>>(
    async (patch) => {
      const { error } = await sb().from("alert_settings").update(patch).eq("space_id", space);
      if (error) throw new Error(error.message);
    },
    ["alert_settings"],
    "Could not save alert settings",
  );
}

export function useUpdateAppSettings() {
  const space = useSpaceId();
  return useTableMutation<Partial<AppSettingsRow>>(
    async (patch) => {
      const { error } = await sb().from("app_settings").update(patch).eq("space_id", space);
      if (error) throw new Error(error.message);
    },
    ["app_settings"],
    "Could not save settings",
  );
}

/** One-time invite code for this space; the plain code is shown exactly once. */
export function useCreateInvite() {
  const space = useSpaceId();
  return useTableMutation<{ role: Exclude<SpaceRole, "owner"> }, string>(
    async ({ role }) => {
      const { data, error } = await sb().rpc("create_space_invite", { p_space: space, p_role: role });
      if (error) throw new Error(error.message);
      return data as string;
    },
    [],
    "Could not create invite",
  );
}

export function useRemoveMember() {
  const space = useSpaceId();
  return useTableMutation<string>(
    async (userId) => {
      const { error } = await sb().rpc("remove_space_member", { p_space: space, p_user: userId });
      if (error) throw new Error(error.message);
    },
    ["members"],
    "Could not remove member",
  );
}

export function useRenameSpace() {
  const space = useSpaceId();
  return useTableMutation<string>(
    async (name) => {
      const { error } = await sb().rpc("rename_space", { p_space: space, p_name: name });
      if (error) throw new Error(error.message);
    },
    [],
    "Could not rename space",
  );
}

/** Join another space with an invite code; returns that space's id. */
export function useRedeemInvite() {
  return useTableMutation<string, string>(
    async (code) => {
      const { data, error } = await sb().rpc("redeem_space_invite", { p_code: code });
      if (error) throw new Error(/invalid|expired/i.test(error.message) ? "That invite code is invalid or expired" : error.message);
      return data as string;
    },
    [],
    "Could not join",
  );
}

export function useSetSpaceDisabled() {
  return useTableMutation<{ id: string; disabled: boolean }>(
    async ({ id, disabled }) => {
      const { error } = await sb().rpc("admin_set_space_disabled", { p_space: id, p_disabled: disabled });
      if (error) throw new Error(error.message);
    },
    ["admin_spaces"],
    "Could not update space",
  );
}

export function useSetSignupsOpen() {
  return useTableMutation<boolean>(
    async (open) => {
      const { error } = await sb().rpc("admin_set_signups_open", { p_open: open });
      if (error) throw new Error(error.message);
    },
    ["signups_open"],
    "Could not change sign-ups",
  );
}

export function useMarkNotificationsRead() {
  return useTableMutation<string[]>(
    async (ids) => {
      const { error } = await sb()
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw new Error(error.message);
    },
    ["notifications"],
    "Could not mark as read",
  );
}
