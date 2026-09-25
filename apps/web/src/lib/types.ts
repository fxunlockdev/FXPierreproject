/** Database row shapes (snake_case, straight from PostgREST). */

export type ChannelRole = "master" | "receiver" | "buffer";
export type ChannelHealth = "ok" | "unavailable" | "no_permission" | "protected" | "unknown";
export type AccountKind = "user" | "bot";
export type AccountStatus = "pending" | "connected" | "relogin_required" | "restricted" | "disabled";
export type ForwardState = "queued" | "scheduled" | "held" | "sending" | "done" | "failed" | "dropped";

export type ChatType = "channel" | "supergroup" | "group";
export type SpaceRole = "owner" | "admin" | "viewer";

/** A private space the signed-in user belongs to (from my_spaces()). */
export interface SpaceInfo {
  id: string;
  name: string;
  role: SpaceRole;
  disabled: boolean;
}

export interface SpaceMemberRow {
  user_id: string;
  email: string;
  role: SpaceRole;
  created_at: string;
}

/** Platform-admin view of a space: metadata only, never its content. */
export interface AdminSpaceRow {
  id: string;
  name: string;
  owner_email: string | null;
  created_at: string;
  disabled: boolean;
  members: number;
  bots: number;
  channels: number;
  routes: number;
  forwards_24h: number;
}

/** A chat a connected account is in — filled by the worker as it sees them. */
export interface DiscoveredChatRow {
  account_id: string;
  tg_chat_id: number | string;
  chat_type: ChatType;
  title: string;
  username: string | null;
  status: "administrator" | "member" | "restricted" | "left" | "kicked";
  can_read: boolean;
  can_post: boolean;
  is_forum: boolean;
  last_seen_at: string;
}

/** A topic of a forum group, as seen by the relay. */
export interface ForumTopicRow {
  tg_chat_id: number | string;
  topic_id: number;
  title: string;
  last_seen_at: string;
}

export interface ChannelRow {
  id: string;
  role: ChannelRole;
  tg_chat_id: number | string | null;
  chat_type: ChatType | null;
  is_forum: boolean;
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

/** A named set of rules any number of routes can follow. */
export interface PresetRow {
  id: string;
  space_id: string;
  name: string;
  rules: unknown;
  created_at: string;
  updated_at: string;
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
  /** when set, the route runs the preset's rules instead of its own */
  preset_id: string | null;
  /** forum master: relay only this topic (null = whole chat) */
  source_topic_id: number | null;
  /** forum receiver: post into this topic (null = General) */
  target_topic_id: number | null;
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

export interface RelayStatusRow {
  heartbeat_at: string;
  simulate: boolean;
}

export interface AlertSettingsRow {
  space_id: string;
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
  space_id: string;
  retention_days: number;
  catchup_window_minutes: number;
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
