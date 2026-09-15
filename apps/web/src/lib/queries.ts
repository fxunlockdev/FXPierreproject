"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabaseBrowser } from "./supabase/client";
import type {
  AccountRow,
  AlertSettingsRow,
  AppSettingsRow,
  AuditRow,
  ChannelRow,
  ForwardRow,
  IncidentRow,
  MemberRow,
  NotificationRow,
  RouteRow,
  WorkerStatusRow,
} from "./types";

const sb = () => supabaseBrowser();

async function selectAll<T>(table: string, order: string, ascending = false, limit = 1000): Promise<T[]> {
  const { data, error } = await sb().from(table).select("*").order(order, { ascending }).limit(limit);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}

// ── reads ──────────────────────────────────────────────────────────────────

export const useChannels = () =>
  useQuery({ queryKey: ["channels"], queryFn: () => selectAll<ChannelRow>("channels", "created_at", true) });

export const useRoutes = () =>
  useQuery({ queryKey: ["routes"], queryFn: () => selectAll<RouteRow>("routes", "created_at", true) });

export const useAccounts = () =>
  useQuery({ queryKey: ["accounts"], queryFn: () => selectAll<AccountRow>("telegram_accounts", "created_at", true) });

export const useWorkerStatus = () =>
  useQuery({
    queryKey: ["worker_status"],
    queryFn: () => selectAll<WorkerStatusRow>("worker_status", "heartbeat_at"),
    refetchInterval: 15_000,
  });

export interface ForwardFilters {
  state?: string;
  kind?: string;
  routeId?: string;
}

export const useForwards = (filters: ForwardFilters = {}, limit = 200) =>
  useQuery({
    queryKey: ["forwards", filters, limit],
    queryFn: async () => {
      let q = sb().from("forwards").select("*").order("created_at", { ascending: false }).limit(limit);
      if (filters.state) q = q.eq("state", filters.state);
      if (filters.kind) q = q.eq("kind", filters.kind);
      if (filters.routeId) q = q.eq("route_id", filters.routeId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as ForwardRow[];
    },
  });

export const useForwardsToday = () =>
  useQuery({
    queryKey: ["forwards", "today"],
    queryFn: async () => {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const { data, error } = await sb()
        .from("forwards")
        .select("id,state,kind,latency_ms,created_at,drop_reason")
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw new Error(error.message);
      return (data ?? []) as Pick<ForwardRow, "id" | "state" | "kind" | "latency_ms" | "created_at" | "drop_reason">[];
    },
    refetchInterval: 30_000,
  });

export const useIncidents = () =>
  useQuery({ queryKey: ["incidents"], queryFn: () => selectAll<IncidentRow>("incidents", "last_seen", false, 100) });

export const useNotifications = () =>
  useQuery({
    queryKey: ["notifications"],
    queryFn: () => selectAll<NotificationRow>("notifications", "created_at", false, 50),
  });

export const useAlertSettings = () =>
  useQuery({
    queryKey: ["alert_settings"],
    queryFn: async () => {
      const { data, error } = await sb().from("alert_settings").select("*").eq("id", 1).single();
      if (error) throw new Error(error.message);
      return data as AlertSettingsRow;
    },
  });

export const useAppSettings = () =>
  useQuery({
    queryKey: ["app_settings"],
    queryFn: async () => {
      const { data, error } = await sb().from("app_settings").select("*").eq("id", 1).single();
      if (error) throw new Error(error.message);
      return data as AppSettingsRow;
    },
  });

export const useMembers = () =>
  useQuery({ queryKey: ["members"], queryFn: () => selectAll<MemberRow>("app_members", "created_at", true, 100) });

export const useAudit = () =>
  useQuery({ queryKey: ["audit"], queryFn: () => selectAll<AuditRow>("audit_log", "created_at", false, 80) });

// ── writes ─────────────────────────────────────────────────────────────────

function useTableMutation<TInput>(
  fn: (input: TInput) => Promise<void>,
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
  return useTableMutation<Partial<ChannelRow> & { role: string }>(
    async (values) => {
      const { error } = await sb().from("channels").insert(values);
      if (error) throw new Error(error.message);
    },
    ["channels"],
    "Could not add channel",
  );
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ChannelRow> }) => {
      const { error } = await sb().from("channels").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["channels"] });
      const previous = qc.getQueryData<ChannelRow[]>(["channels"]);
      qc.setQueryData<ChannelRow[]>(["channels"], (old) =>
        (old ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["channels"], ctx.previous);
      toast.error(`Change reverted: ${err.message}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["channels"] }),
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
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<RouteRow> }) => {
      const { error } = await sb().from("routes").update(patch).eq("id", id);
      if (error) throw new Error(error.message);
    },
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["routes"] });
      const previous = qc.getQueryData<RouteRow[]>(["routes"]);
      qc.setQueryData<RouteRow[]>(["routes"], (old) =>
        (old ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(["routes"], ctx.previous);
      toast.error(`Change reverted: ${err.message}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["routes"] }),
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
  return useTableMutation<Partial<AlertSettingsRow>>(
    async (patch) => {
      const { error } = await sb().from("alert_settings").update(patch).eq("id", 1);
      if (error) throw new Error(error.message);
    },
    ["alert_settings"],
    "Could not save alert settings",
  );
}

export function useUpdateAppSettings() {
  return useTableMutation<Partial<AppSettingsRow>>(
    async (patch) => {
      const { error } = await sb().from("app_settings").update(patch).eq("id", 1);
      if (error) throw new Error(error.message);
    },
    ["app_settings"],
    "Could not save settings",
  );
}

export function useAddMember() {
  return useTableMutation<{ email: string; role: string }>(
    async (values) => {
      const { error } = await sb()
        .from("app_members")
        .insert({ email: values.email.toLowerCase(), role: values.role });
      if (error) throw new Error(error.message);
    },
    ["members"],
    "Could not invite member",
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
