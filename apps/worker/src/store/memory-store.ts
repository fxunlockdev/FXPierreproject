import { randomUUID } from 'node:crypto';
import type {
  AlertSettings,
  ChannelHealth,
  ForwardRecord,
  Heartbeat,
  IncidentKind,
  NewForward,
  RelayConfig,
} from '../model.js';
import type { IncidentRefs, Store } from './store.js';

interface MemoryIncident {
  id: string;
  kind: IncidentKind;
  refs: IncidentRefs;
  status: 'open' | 'resolved';
  message: string;
}

/** In-memory Store used by unit tests and the pure-simulation demo mode. */
export class MemoryStore implements Store {
  config: RelayConfig = { accounts: [], channels: [], memberships: [], routes: [] };
  forwards = new Map<string, ForwardRecord>();
  incidents: MemoryIncident[] = [];
  notifications: { kind: string; title: string; body: string }[] = [];
  secrets = new Map<string, string>();
  heartbeats: Heartbeat[] = [];
  alertSettings: AlertSettings = {
    telegramEnabled: true,
    telegramTarget: null,
    emailEnabled: false,
    emailTo: null,
    webhookEnabled: false,
    webhookUrl: null,
    cooldownMinutes: 15,
    triggers: {},
  };
  private listeners = new Set<() => void>();

  async loadConfig(): Promise<RelayConfig> {
    return structuredClone(this.config);
  }

  onConfigChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emitConfigChange(): void {
    for (const cb of this.listeners) cb();
  }

  async upsertForward(f: NewForward): Promise<{ id: string; deduped: boolean }> {
    const existing = [...this.forwards.values()].find(
      (x) => x.routeId === f.routeId && x.srcMessageId === f.srcMessageId && x.kind === f.kind,
    );
    if (existing) {
      if (f.kind === 'edit') {
        Object.assign(existing, f, { id: existing.id, createdAt: existing.createdAt });
        return { id: existing.id, deduped: false };
      }
      return { id: existing.id, deduped: true };
    }
    const id = randomUUID();
    this.forwards.set(id, { ...f, id, attempts: f.attempts ?? 0, createdAt: new Date() });
    return { id, deduped: false };
  }

  async updateForward(id: string, patch: Partial<ForwardRecord>): Promise<void> {
    const row = this.forwards.get(id);
    if (row) Object.assign(row, patch);
  }

  async claimDue(now: Date, limit: number): Promise<ForwardRecord[]> {
    const due = [...this.forwards.values()]
      .filter(
        (f) =>
          ['queued', 'scheduled', 'held'].includes(f.state) &&
          f.deliverAt.getTime() <= now.getTime(),
      )
      .sort((a, b) => a.deliverAt.getTime() - b.deliverAt.getTime())
      .slice(0, limit);
    for (const f of due) f.state = 'sending';
    return structuredClone(due);
  }

  async findDone(routeId: string, srcMessageId: number): Promise<ForwardRecord | null> {
    return (
      [...this.forwards.values()].find(
        (f) =>
          f.routeId === routeId &&
          f.kind === 'post' &&
          f.state === 'done' &&
          (f.srcMessageId === srcMessageId || (f.srcMessageIds ?? []).includes(srcMessageId)),
      ) ?? null
    );
  }

  async countPending(): Promise<number> {
    return [...this.forwards.values()].filter((f) =>
      ['queued', 'scheduled', 'held', 'sending'].includes(f.state),
    ).length;
  }

  async heartbeat(hb: Heartbeat): Promise<void> {
    this.heartbeats.push(hb);
  }

  async openIncident(kind: IncidentKind, refs: IncidentRefs, message: string) {
    const open = this.incidents.find(
      (i) =>
        i.kind === kind &&
        i.status === 'open' &&
        i.refs.channelId === refs.channelId &&
        i.refs.accountId === refs.accountId &&
        i.refs.routeId === refs.routeId,
    );
    if (open) return { id: open.id, isNew: false };
    const id = randomUUID();
    this.incidents.push({ id, kind, refs, status: 'open', message });
    return { id, isNew: true };
  }

  async resolveIncidents(kind: IncidentKind, refs: IncidentRefs): Promise<void> {
    for (const i of this.incidents) {
      if (
        i.kind === kind &&
        i.status === 'open' &&
        (refs.channelId === undefined || i.refs.channelId === refs.channelId) &&
        (refs.accountId === undefined || i.refs.accountId === refs.accountId) &&
        (refs.routeId === undefined || i.refs.routeId === refs.routeId)
      ) {
        i.status = 'resolved';
      }
    }
  }

  async notify(kind: string, title: string, body: string): Promise<void> {
    this.notifications.push({ kind, title, body });
  }

  async setChannelHealth(channelId: string, health: ChannelHealth, error?: string): Promise<void> {
    const ch = this.config.channels.find((c) => c.id === channelId);
    if (ch) {
      ch.health = health;
      if (health === 'protected') ch.isProtected = true;
      void error;
    }
  }

  async setChannelLastMessage(): Promise<void> {}

  async setAccountStatus(accountId: string, status: string): Promise<void> {
    const acc = this.config.accounts.find((a) => a.id === accountId);
    if (acc) acc.status = status as never;
  }

  async disableRoute(routeId: string): Promise<void> {
    const r = this.config.routes.find((x) => x.id === routeId);
    if (r) r.enabled = false;
  }

  async getSecret(accountId: string): Promise<string | null> {
    return this.secrets.get(accountId) ?? null;
  }

  async setSecret(accountId: string, secret: string): Promise<void> {
    this.secrets.set(accountId, secret);
  }

  async getAlertSettings(): Promise<AlertSettings> {
    return structuredClone(this.alertSettings);
  }

  async getAppSettings() {
    return { retentionDays: 30, catchupWindowMinutes: 15 };
  }
}
