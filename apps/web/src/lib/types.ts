/** Database row shapes (snake_case, straight from PostgREST). */

export type ChannelRole = "master" | "receiver" | "buffer";
export type ChannelHealth = "ok" | "unavailable" | "no_permission" | "protected" | "unknown";
export type AccountKind = "user" | "bot";
export type AccountStatus = "pending" | "connected" | "relogin_required" | "restricted" | "disabled";
export type ForwardState = "queued" | "scheduled" | "held" | "sending" | "done" | "failed" | "dropped";

export interface ChannelRow {
  id: string;
  role: ChannelRole;
  tg_chat_id: number | string | null;
  title: string;
  username: string | null;
  invite_link: string | null;
  enabled: boolean;
  health: ChannelHealth;
  is_protected: boolean;
  member_count: number | null;
  last_message_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface RouteRow {
  id: string;
  master_id: string;
  receiver_id: string;
  enabled: boolean;
  mode: "copy" | "forward";
  silent: boolean;
  sender_account_id: string | null;
  use_fanout: boolean;
  delay_seconds: number;
  schedule: unknown;
  paused_until: string | null;
  sync_edits: boolean;
  sync_deletes: boolean;
  rules: unknown;
  created_at: string;
}

export interface AccountRow {
  id: string;
  kind: AccountKind;
  label: string;
  phone: string | null;
  username: string | null;
  tg_id: number | string | null;
  status: AccountStatus;
  is_reader: boolean;
  is_sender: boolean;
  is_alert_sender: boolean;
  max_msgs_per_minute: number;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ForwardRow {
  id: string;
  route_id: string;
  master_channel_id: string;
  receiver_channel_id: string;
  src_message_id: number;
  src_message_ids: number[] | null;
  album_key: string | null;
  kind: "post" | "edit" | "delete";
  state: ForwardState;
  drop_reason: string | null;
  deliver_at: string;
  attempts: number;
  last_error: string | null;
  sender_account_id: string | null;
  dest_message_ids: number[] | null;
  latency_ms: number | null;
  preview: string | null;
  media_kind: string | null;
  created_at: string;
}

export interface IncidentRow {
  id: string;
  kind: string;
  status: "open" | "resolved";
  channel_id: string | null;
  account_id: string | null;
  route_id: string | null;
  message: string;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  incident_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface WorkerStatusRow {
  instance_id: string;
  started_at: string;
  heartbeat_at: string;
  version: string | null;
  accounts_online: number;
  queue_depth: number;
  simulate: boolean;
}

export interface AlertSettingsRow {
  id: number;
  telegram_enabled: boolean;
  telegram_target: string | null;
  email_enabled: boolean;
  email_to: string | null;
  webhook_enabled: boolean;
  webhook_url: string | null;
  quiet_hours: unknown;
  cooldown_minutes: number;
  triggers: Record<string, boolean>;
  digest_enabled: boolean;
}

export interface AppSettingsRow {
  id: number;
  retention_days: number;
  catchup_window_minutes: number;
}

export interface MemberRow {
  id: string;
  user_id: string | null;
  email: string;
  role: "admin" | "viewer";
  created_at: string;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  created_at: string;
}

export const INCIDENT_LABELS: Record<string, string> = {
  receiver_no_permission: "Receiver unreachable",
  master_unavailable: "Master unavailable",
  protected_content: "Protected content",
  session_revoked: "Account needs re-login",
  account_restricted: "Account restricted",
  worker_offline: "Relay offline",
  flood_wait: "Rate limited",
  master_silent: "Master gone quiet",
  route_autopaused: "Route auto-paused",
};
