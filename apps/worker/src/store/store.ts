import type {
  AlertSettings,
  ChannelHealth,
  ForwardRecord,
  Heartbeat,
  IncidentKind,
  NewForward,
  RelayConfig,
} from '../model';

export interface IncidentRefs {
  channelId?: string;
  accountId?: string;
  routeId?: string;
}

/**
 * Persistence boundary for the relay engine. The engine never talks to
 * Supabase directly — production uses SupabaseStore, tests use MemoryStore.
 */
export interface Store {
  loadConfig(): Promise<RelayConfig>;
  /** Fires when config tables change; returns an unsubscribe function. */
  onConfigChange(cb: () => void): () => void;

  /**
   * Insert a forward. For kind 'post' a duplicate (route, src, kind) is a
   * no-op returning deduped=true; for 'edit' the existing row is re-queued.
   */
  upsertForward(f: NewForward): Promise<{ id: string; deduped: boolean }>;
  updateForward(id: string, patch: Partial<ForwardRecord>): Promise<void>;
  /** Atomically claim due queued/scheduled/held rows (sets them to sending). */
  claimDue(now: Date, limit: number): Promise<ForwardRecord[]>;
  /** Latest completed 'post' forward for edit/delete sync. */
  findDone(routeId: string, srcMessageId: number): Promise<ForwardRecord | null>;
  countPending(): Promise<number>;

  heartbeat(hb: Heartbeat): Promise<void>;

  openIncident(
    kind: IncidentKind,
    refs: IncidentRefs,
    message: string,
  ): Promise<{ id: string; isNew: boolean }>;
  resolveIncidents(kind: IncidentKind, refs: IncidentRefs): Promise<void>;
  notify(kind: string, title: string, body: string, incidentId?: string): Promise<void>;

  setChannelHealth(channelId: string, health: ChannelHealth, error?: string): Promise<void>;
  setChannelLastMessage(channelId: string, at: Date): Promise<void>;
  setAccountStatus(accountId: string, status: string, error?: string): Promise<void>;
  disableRoute(routeId: string): Promise<void>;

  getSecret(accountId: string): Promise<string | null>;
  setSecret(accountId: string, secret: string): Promise<void>;

  getAlertSettings(): Promise<AlertSettings>;
  getAppSettings(): Promise<{ retentionDays: number; catchupWindowMinutes: number }>;
}
