import type { MediaKind, RouteRules, RouteSchedule } from '@pierre/core';

export type AccountKind = 'user' | 'bot';
export type AccountStatus = 'pending' | 'connected' | 'relogin_required' | 'restricted' | 'disabled';
export type ChannelRole = 'master' | 'receiver' | 'buffer';
export type ChannelHealth = 'ok' | 'unavailable' | 'no_permission' | 'protected' | 'unknown';
export type ForwardState = 'queued' | 'scheduled' | 'held' | 'sending' | 'done' | 'failed' | 'dropped';
export type ForwardKind = 'post' | 'edit' | 'delete';
export type IncidentKind =
  | 'receiver_no_permission'
  | 'master_unavailable'
  | 'protected_content'
  | 'session_revoked'
  | 'account_restricted'
  | 'worker_offline'
  | 'flood_wait'
  | 'master_silent'
  | 'route_autopaused';

export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  status: AccountStatus;
  isReader: boolean;
  isSender: boolean;
  isAlertSender: boolean;
  maxMsgsPerMinute: number;
  tgId?: string;
  username?: string;
}

export interface Channel {
  id: string;
  role: ChannelRole;
  tgChatId: string | null;
  title: string;
  username?: string;
  inviteLink?: string;
  enabled: boolean;
  health: ChannelHealth;
  isProtected: boolean;
  /** A group with Topics enabled */
  isForum?: boolean;
}

export interface Membership {
  accountId: string;
  channelId: string;
  isMember: boolean;
  isAdmin: boolean;
  canPost: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface Route {
  id: string;
  masterId: string;
  receiverId: string;
  enabled: boolean;
  mode: 'copy' | 'forward';
  silent: boolean;
  senderAccountId: string | null;
  useFanout: boolean;
  delaySeconds: number;
  schedule: RouteSchedule | null;
  pausedUntil: Date | null;
  syncEdits: boolean;
  syncDeletes: boolean;
  rules: RouteRules;
  /** Relay only posts from this topic of a forum master (null = every topic). */
  sourceTopicId?: number | null;
  /** Post into this topic of a forum receiver (null = General). */
  targetTopicId?: number | null;
}

export interface RelayConfig {
  accounts: Account[];
  channels: Channel[];
  memberships: Membership[];
  routes: Route[];
}

export interface ForwardRecord {
  id: string;
  routeId: string;
  masterChannelId: string;
  receiverChannelId: string;
  srcMessageId: number;
  srcMessageIds?: number[];
  albumKey?: string;
  kind: ForwardKind;
  state: ForwardState;
  dropReason?: string;
  deliverAt: Date;
  attempts: number;
  lastError?: string;
  senderAccountId?: string;
  destMessageIds?: number[];
  latencyMs?: number;
  preview?: string;
  mediaKind?: MediaKind;
  /** Persisted transformed content (ForwardPayload) so delays survive restarts */
  payload?: unknown;
  createdAt: Date;
}

export type NewForward = Omit<ForwardRecord, 'id' | 'createdAt' | 'attempts'> & {
  attempts?: number;
};

export interface AlertSettings {
  telegramEnabled: boolean;
  telegramTarget: string | null;
  emailEnabled: boolean;
  emailTo: string | null;
  webhookEnabled: boolean;
  webhookUrl: string | null;
  cooldownMinutes: number;
  triggers: Record<string, boolean>;
}

export interface Heartbeat {
  instanceId: string;
  startedAt: Date;
  version: string;
  accountsOnline: number;
  queueDepth: number;
  simulate: boolean;
}
