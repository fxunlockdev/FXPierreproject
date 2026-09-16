import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { parseRouteRules, parseRouteSchedule } from '@pierre/core';
import type {
  AlertSettings,
  ChannelHealth,
  ForwardRecord,
  Heartbeat,
  IncidentKind,
  NewForward,
  RelayConfig,
} from '../model';
import type { DiscoveredChat, ResolvedChannel } from '../transport/transport';
import type { IncidentRefs, Store } from './store';

type Row = Record<string, unknown>;

/** External alert hook — invoked after an in-app notification is written. */
export type AlertSink = (kind: string, title: string, body: string) => void;

const CONFIG_TABLES = ['channels', 'routes', 'telegram_accounts', 'channel_memberships'];

export class SupabaseStore implements Store {
  private sb: SupabaseClient;
  private lastHealth = new Map<string, ChannelHealth>();

  constructor(
    url: string,
    serviceRoleKey: string,
    private alertSink: AlertSink = () => {},
  ) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private fail(op: string, error: { message: string } | null): void {
    if (error) throw new Error(`supabase ${op}: ${error.message}`);
  }

  async loadConfig(): Promise<RelayConfig> {
    const [accounts, channels, memberships, routes] = await Promise.all([
      // deterministic order — Postgres heap order shifts as rows are updated
      this.sb.from('telegram_accounts').select('*').order('created_at'),
      this.sb.from('channels').select('*').order('created_at'),
      this.sb.from('channel_memberships').select('*'),
      this.sb.from('routes').select('*').order('created_at'),
    ]);
    this.fail('accounts', accounts.error);
    this.fail('channels', channels.error);
    this.fail('memberships', memberships.error);
    this.fail('routes', routes.error);

    return {
      accounts: (accounts.data ?? []).map((r: Row) => ({
        id: r['id'] as string,
        kind: r['kind'] as 'user' | 'bot',
        label: r['label'] as string,
        status: r['status'] as never,
        isReader: r['is_reader'] as boolean,
        isSender: r['is_sender'] as boolean,
        isAlertSender: r['is_alert_sender'] as boolean,
        maxMsgsPerMinute: r['max_msgs_per_minute'] as number,
        tgId: r['tg_id'] == null ? undefined : String(r['tg_id']),
        username: (r['username'] as string) ?? undefined,
      })),
      channels: (channels.data ?? []).map((r: Row) => ({
        id: r['id'] as string,
        role: r['role'] as never,
        tgChatId: r['tg_chat_id'] == null ? null : String(r['tg_chat_id']),
        title: r['title'] as string,
        username: (r['username'] as string) ?? undefined,
        inviteLink: (r['invite_link'] as string) ?? undefined,
        enabled: r['enabled'] as boolean,
        health: r['health'] as ChannelHealth,
        isProtected: r['is_protected'] as boolean,
        isForum: Boolean(r['is_forum']),
      })),
      memberships: (memberships.data ?? []).map((r: Row) => ({
        accountId: r['account_id'] as string,
        channelId: r['channel_id'] as string,
        isMember: r['is_member'] as boolean,
        isAdmin: r['is_admin'] as boolean,
        canPost: r['can_post'] as boolean,
        canEdit: r['can_edit'] as boolean,
        canDelete: r['can_delete'] as boolean,
      })),
      routes: (routes.data ?? []).map((r: Row) => ({
        id: r['id'] as string,
        masterId: r['master_id'] as string,
        receiverId: r['receiver_id'] as string,
        enabled: r['enabled'] as boolean,
        mode: r['mode'] as 'copy' | 'forward',
        silent: r['silent'] as boolean,
        senderAccountId: (r['sender_account_id'] as string) ?? null,
        useFanout: r['use_fanout'] as boolean,
        delaySeconds: r['delay_seconds'] as number,
        schedule: parseRouteSchedule(r['schedule'], (detail) =>
          console.warn(`[store] route ${r['id']} has an invalid schedule (ignored): ${detail}`),
        ),
        pausedUntil: r['paused_until'] ? new Date(r['paused_until'] as string) : null,
        syncEdits: r['sync_edits'] as boolean,
        syncDeletes: r['sync_deletes'] as boolean,
        sourceTopicId: r['source_topic_id'] == null ? null : Number(r['source_topic_id']),
        targetTopicId: r['target_topic_id'] == null ? null : Number(r['target_topic_id']),
        rules: parseRouteRules(r['rules'], (detail) =>
          console.warn(`[store] route ${r['id']} has invalid rules (defaults used): ${detail}`),
        ),
      })),
    };
  }

  onConfigChange(cb: () => void): () => void {
    let timer: NodeJS.Timeout | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(cb, 300);
    };
    let channel = this.sb.channel('worker-config');
    for (const table of CONFIG_TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        debounced,
      );
    }
    channel.subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void this.sb.removeChannel(channel);
    };
  }

  private toRow(f: Partial<NewForward> & Partial<ForwardRecord>): Row {
    const row: Row = {};
    if (f.routeId !== undefined) row['route_id'] = f.routeId;
    if (f.masterChannelId !== undefined) row['master_channel_id'] = f.masterChannelId;
    if (f.receiverChannelId !== undefined) row['receiver_channel_id'] = f.receiverChannelId;
    if (f.srcMessageId !== undefined) row['src_message_id'] = f.srcMessageId;
    if (f.srcMessageIds !== undefined) row['src_message_ids'] = f.srcMessageIds;
    if (f.albumKey !== undefined) row['album_key'] = f.albumKey;
    if (f.kind !== undefined) row['kind'] = f.kind;
    if (f.state !== undefined) row['state'] = f.state;
    if (f.dropReason !== undefined) row['drop_reason'] = f.dropReason;
    if (f.deliverAt !== undefined) row['deliver_at'] = f.deliverAt.toISOString();
    if (f.attempts !== undefined) row['attempts'] = f.attempts;
    if (f.lastError !== undefined) row['last_error'] = f.lastError;
    if (f.senderAccountId !== undefined) row['sender_account_id'] = f.senderAccountId;
    if (f.destMessageIds !== undefined) row['dest_message_ids'] = f.destMessageIds;
    if (f.latencyMs !== undefined) row['latency_ms'] = Math.round(f.latencyMs);
    if (f.preview !== undefined) row['preview'] = f.preview;
    if (f.mediaKind !== undefined) row['media_kind'] = f.mediaKind;
    if (f.payload !== undefined) row['payload'] = f.payload;
    return row;
  }

  private fromRow(r: Row): ForwardRecord {
    return {
      id: r['id'] as string,
      routeId: r['route_id'] as string,
      masterChannelId: r['master_channel_id'] as string,
      receiverChannelId: r['receiver_channel_id'] as string,
      srcMessageId: Number(r['src_message_id']),
      srcMessageIds: (r['src_message_ids'] as number[] | null)?.map(Number),
      albumKey: (r['album_key'] as string) ?? undefined,
      kind: r['kind'] as never,
      state: r['state'] as never,
      dropReason: (r['drop_reason'] as string) ?? undefined,
      deliverAt: new Date(r['deliver_at'] as string),
      attempts: r['attempts'] as number,
      lastError: (r['last_error'] as string) ?? undefined,
      senderAccountId: (r['sender_account_id'] as string) ?? undefined,
      destMessageIds: (r['dest_message_ids'] as number[] | null)?.map(Number),
      latencyMs: (r['latency_ms'] as number) ?? undefined,
      preview: (r['preview'] as string) ?? undefined,
      mediaKind: (r['media_kind'] as never) ?? undefined,
      payload: r['payload'] ?? undefined,
      createdAt: new Date(r['created_at'] as string),
    };
  }

  async upsertForward(f: NewForward): Promise<{ id: string; deduped: boolean }> {
    const { data, error } = await this.sb
      .from('forwards')
      .upsert(this.toRow({ attempts: 0, ...f }), {
        onConflict: 'route_id,src_message_id,kind',
        ignoreDuplicates: f.kind === 'post',
      })
      .select('id');
    this.fail('upsertForward', error);
    const id = data?.[0]?.id as string | undefined;
    return { id: id ?? '', deduped: id === undefined };
  }

  async updateForward(id: string, patch: Partial<ForwardRecord>): Promise<void> {
    const { error } = await this.sb.from('forwards').update(this.toRow(patch)).eq('id', id);
    this.fail('updateForward', error);
  }

  async claimDue(_now: Date, limit: number): Promise<ForwardRecord[]> {
    const { data, error } = await this.sb.rpc('claim_due_forwards', { p_limit: limit });
    this.fail('claimDue', error);
    return ((data as Row[]) ?? []).map((r) => this.fromRow(r));
  }

  async parkStaleSending(before: Date, note: string): Promise<number> {
    const { data, error } = await this.sb
      .from('forwards')
      .update({ state: 'failed', last_error: note })
      .eq('state', 'sending')
      .lt('updated_at', before.toISOString())
      .select('id');
    this.fail('parkStaleSending', error);
    return (data ?? []).length;
  }

  async findPost(
    routeId: string,
    srcMessageId: number,
  ): Promise<{
    id: string;
    state: ForwardRecord['state'];
    receiverChannelId: string;
    destMessageIds?: number[];
  } | null> {
    const { data, error } = await this.sb
      .from('forwards')
      .select('id, state, receiver_channel_id, dest_message_ids')
      .eq('route_id', routeId)
      .eq('kind', 'post')
      .or(`src_message_id.eq.${srcMessageId},src_message_ids.cs.{${srcMessageId}}`)
      .order('created_at', { ascending: false })
      .limit(1);
    this.fail('findPost', error);
    const row = (data as Row[] | null)?.[0];
    if (!row) return null;
    return {
      id: row['id'] as string,
      state: row['state'] as ForwardRecord['state'],
      receiverChannelId: row['receiver_channel_id'] as string,
      destMessageIds: (row['dest_message_ids'] as number[] | null)?.map(Number),
    };
  }

  async countPending(): Promise<number> {
    const { count, error } = await this.sb
      .from('forwards')
      .select('id', { count: 'exact', head: true })
      .in('state', ['queued', 'scheduled', 'held', 'sending']);
    this.fail('countPending', error);
    return count ?? 0;
  }

  async heartbeat(hb: Heartbeat): Promise<void> {
    const { error } = await this.sb.from('worker_status').upsert({
      instance_id: hb.instanceId,
      started_at: hb.startedAt.toISOString(),
      heartbeat_at: new Date().toISOString(),
      version: hb.version,
      accounts_online: hb.accountsOnline,
      queue_depth: hb.queueDepth,
      simulate: hb.simulate,
    });
    this.fail('heartbeat', error);
  }

  async openIncident(kind: IncidentKind, refs: IncidentRefs, message: string) {
    let query = this.sb.from('incidents').select('id').eq('kind', kind).eq('status', 'open');
    if (refs.channelId) query = query.eq('channel_id', refs.channelId);
    if (refs.accountId) query = query.eq('account_id', refs.accountId);
    if (refs.routeId) query = query.eq('route_id', refs.routeId);
    const existing = await query.limit(1);
    this.fail('openIncident.find', existing.error);

    const found = existing.data?.[0]?.id as string | undefined;
    if (found) {
      await this.sb.from('incidents').update({ last_seen: new Date().toISOString(), message }).eq('id', found);
      return { id: found, isNew: false };
    }

    const { data, error } = await this.sb
      .from('incidents')
      .insert({
        kind,
        status: 'open',
        channel_id: refs.channelId ?? null,
        account_id: refs.accountId ?? null,
        route_id: refs.routeId ?? null,
        message,
      })
      .select('id')
      .single();
    this.fail('openIncident.insert', error);
    return { id: data!.id as string, isNew: true };
  }

  async resolveIncidents(kind: IncidentKind, refs: IncidentRefs): Promise<void> {
    let query = this.sb
      .from('incidents')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('kind', kind)
      .eq('status', 'open');
    if (refs.channelId) query = query.eq('channel_id', refs.channelId);
    if (refs.accountId) query = query.eq('account_id', refs.accountId);
    if (refs.routeId) query = query.eq('route_id', refs.routeId);
    const { error } = await query;
    this.fail('resolveIncidents', error);
  }

  async notify(kind: string, title: string, body: string, incidentId?: string): Promise<void> {
    const { error } = await this.sb.from('notifications').insert({
      kind,
      title,
      body,
      incident_id: incidentId ?? null,
    });
    this.fail('notify', error);
    try {
      this.alertSink(kind, title, body);
    } catch {
      // external alert failures must never break the relay path
    }
  }

  async upsertDiscoveredChat(accountId: string, chat: DiscoveredChat): Promise<void> {
    const { error } = await this.sb.from('discovered_chats').upsert(
      {
        account_id: accountId,
        tg_chat_id: chat.tgChatId,
        chat_type: chat.chatType,
        title: chat.title,
        username: chat.username ?? null,
        status: chat.status,
        can_read: chat.canRead,
        can_post: chat.canPost,
        is_forum: chat.isForum,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,tg_chat_id' },
    );
    this.fail('upsertDiscoveredChat', error);
  }

  async noteForumTopic(chatId: string, topicId: number, title: string): Promise<void> {
    const { error } = await this.sb.rpc('note_forum_topic', {
      p_chat: chatId,
      p_topic: topicId,
      p_title: title,
    });
    this.fail('noteForumTopic', error);
  }

  async migrateChatId(oldChatId: string, newChatId: string): Promise<void> {
    const { error } = await this.sb.rpc('migrate_chat_id', { p_old: oldChatId, p_new: newChatId });
    this.fail('migrateChatId', error);
  }

  async setChannelHealth(channelId: string, health: ChannelHealth, error?: string): Promise<void> {
    if (this.lastHealth.get(channelId) === health) return;
    this.lastHealth.set(channelId, health);
    const patch: Row = { health, last_error: error ?? null };
    if (health === 'protected') patch['is_protected'] = true;
    const res = await this.sb.from('channels').update(patch).eq('id', channelId);
    this.fail('setChannelHealth', res.error);
  }

  async setChannelLastMessage(channelId: string, at: Date): Promise<void> {
    const { error } = await this.sb
      .from('channels')
      .update({ last_message_at: at.toISOString() })
      .eq('id', channelId);
    this.fail('setChannelLastMessage', error);
  }

  async setAccountStatus(accountId: string, status: string, error?: string): Promise<void> {
    const res = await this.sb
      .from('telegram_accounts')
      .update({ status, last_error: error ?? null, last_seen_at: new Date().toISOString() })
      .eq('id', accountId);
    this.fail('setAccountStatus', res.error);
  }

  async disableRoute(routeId: string): Promise<void> {
    const { error } = await this.sb.from('routes').update({ enabled: false }).eq('id', routeId);
    this.fail('disableRoute', error);
  }

  async getSecret(accountId: string): Promise<string | null> {
    const { data, error } = await this.sb
      .from('account_secrets')
      .select('secret')
      .eq('account_id', accountId)
      .maybeSingle();
    this.fail('getSecret', error);
    return (data?.secret as string) ?? null;
  }

  async setSecret(accountId: string, secret: string): Promise<void> {
    const { error } = await this.sb
      .from('account_secrets')
      .upsert({ account_id: accountId, secret });
    this.fail('setSecret', error);
  }

  async getAlertSettings(): Promise<AlertSettings> {
    const { data, error } = await this.sb.from('alert_settings').select('*').eq('id', 1).single();
    this.fail('getAlertSettings', error);
    const r = data as Row;
    return {
      telegramEnabled: r['telegram_enabled'] as boolean,
      telegramTarget: (r['telegram_target'] as string) ?? null,
      emailEnabled: r['email_enabled'] as boolean,
      emailTo: (r['email_to'] as string) ?? null,
      webhookEnabled: r['webhook_enabled'] as boolean,
      webhookUrl: (r['webhook_url'] as string) ?? null,
      cooldownMinutes: r['cooldown_minutes'] as number,
      triggers: (r['triggers'] as Record<string, boolean>) ?? {},
    };
  }

  async getAppSettings() {
    const { data, error } = await this.sb.from('app_settings').select('*').eq('id', 1).single();
    this.fail('getAppSettings', error);
    return {
      retentionDays: (data as Row)['retention_days'] as number,
      catchupWindowMinutes: (data as Row)['catchup_window_minutes'] as number,
    };
  }

  /** Used by the admin API to register accounts created via login flows. */
  async insertAccount(fields: {
    kind: 'user' | 'bot';
    label: string;
    phone?: string;
    username?: string;
    tgId?: string;
    status: string;
    isAlertSender?: boolean;
  }): Promise<string> {
    const { data, error } = await this.sb
      .from('telegram_accounts')
      .insert({
        kind: fields.kind,
        label: fields.label,
        phone: fields.phone ?? null,
        username: fields.username ?? null,
        tg_id: fields.tgId ?? null,
        status: fields.status,
        is_alert_sender: fields.isAlertSender ?? false,
      })
      .select('id')
      .single();
    this.fail('insertAccount', error);
    return data!.id as string;
  }

  /** Channel + membership upserts used by resolve/join admin endpoints. */
  async upsertChannelMeta(
    channelId: string,
    meta: ResolvedChannel,
  ): Promise<void> {
    const { error } = await this.sb
      .from('channels')
      .update({
        tg_chat_id: meta.tgChatId,
        title: meta.title,
        username: meta.username ?? null,
        chat_type: meta.chatType ?? null,
        is_forum: meta.isForum ?? false,
        is_protected: meta.isProtected,
        health: meta.isProtected ? 'protected' : 'ok',
      })
      .eq('id', channelId);
    this.fail('upsertChannelMeta', error);
  }

  async upsertMembership(m: {
    accountId: string;
    channelId: string;
    isMember: boolean;
    isAdmin: boolean;
    canPost: boolean;
    canEdit: boolean;
    canDelete: boolean;
  }): Promise<void> {
    const { error } = await this.sb.from('channel_memberships').upsert(
      {
        account_id: m.accountId,
        channel_id: m.channelId,
        is_member: m.isMember,
        is_admin: m.isAdmin,
        can_post: m.canPost,
        can_edit: m.canEdit,
        can_delete: m.canDelete,
        checked_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,channel_id' },
    );
    this.fail('upsertMembership', error);
  }
}
