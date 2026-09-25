import {
  applyRules,
  resolveTiming,
  type PipelineContext,
  type RelayMessage,
  type RichText,
  type RouteRules,
} from '@pierre/core';
import type { Account, Channel, ForwardRecord, NewForward, RelayConfig, Route } from './model';
import type { Store } from './store/store';
import {
  TransportError,
  type AlbumItem,
  type ReaderHandlers,
  type Transport,
} from './transport/transport';

/** Rows with no space (single-tenant fixtures, the simulator) share the '' space. */
const spaceOf = (row: { spaceId?: string }): string => row.spaceId ?? '';

export interface ForwardPayload {
  srcText: RichText;
  output: RichText;
  removeButtons: boolean;
  /** Album items in order, so the album can be re-sent grouped */
  items?: AlbumItem[];
}

export interface EngineOptions {
  /** Quiet period that closes an album; every new item restarts it. */
  albumWaitMs?: number;
  /** Hard cap on how long an album is held open. */
  albumMaxWaitMs?: number;
  maxAttempts?: number;
  /** Backoff between retries, seconds per attempt index */
  backoffSeconds?: number[];
  /** Consecutive delivery failures before a route is auto-paused */
  autopauseAfter?: number;
  /** Rows stuck in `sending` longer than this are parked as failed (never requeued). */
  staleSendingSeconds?: number;
  /**
   * Send due-now forwards straight from ingest, instead of persisting them as
   * queued and waiting for the sender loop's next claim — the difference
   * between ~1 and ~3 database round trips (plus a tick) on the hot path.
   */
  immediateDelivery?: boolean;
  clock?: () => Date;
}

const DEFAULTS: Required<EngineOptions> = {
  albumWaitMs: 500,
  albumMaxWaitMs: 2000,
  maxAttempts: 5,
  backoffSeconds: [1, 5, 30, 120, 600],
  autopauseAfter: 3,
  staleSendingSeconds: 180,
  immediateDelivery: false,
  clock: () => new Date(),
};

/** Telegram's global bot limit is ~30 msgs/s; stay just under it. */
const BOT_MSGS_PER_SECOND = 25;

/**
 * The relay brain: ingests posts from readers, runs the rules pipeline,
 * persists the queue, and delivers with pacing, retries and incident logic.
 * Talks to Telegram only through Transport, and to storage only through Store.
 */
export class RelayEngine {
  private cfg: RelayConfig = { accounts: [], channels: [], memberships: [], routes: [] };
  /** space → tg chat id → master channel */
  private mastersBySpace = new Map<string, Map<string, Channel>>();
  private accountsById = new Map<string, Account>();
  private channelsById = new Map<string, Channel>();
  private routesByMaster = new Map<string, Route[]>();
  private routesById = new Map<string, Route>();
  /** tg chat id → account id → rights there (from discovery) */
  private accessByChat = new Map<string, Map<string, { canRead: boolean; canPost: boolean }>>();

  private transports = new Map<string, Transport>();
  private albumBuffer = new Map<
    string,
    { msgs: RelayMessage[]; timer: NodeJS.Timeout; firstAt: number }
  >();
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  /** Recent send timestamps per rate-limit key (sliding windows). */
  private sendWindows = new Map<string, number[]>();
  /** Per-master processing chain: posts, edits and deletes keep arrival order. */
  private masterChains = new Map<string, Promise<void>>();
  /** chat:message ids we delivered — so A → B → A setups can't loop. */
  private sentByUs = new Set<string>();
  private sentByUsOrder: string[] = [];
  private lastMasterTouch = new Map<string, number>();
  private consecutiveFails = new Map<string, number>();
  private bufferCopies = new Map<string, number[]>();
  private unsubscribe: (() => void) | null = null;
  private opts: Required<EngineOptions>;

  readonly handlers: ReaderHandlers = {
    onPost: (accountId, msg) => this.ingest({ ...msg, readerAccountId: msg.readerAccountId ?? accountId }),
    onEdit: async (accountId, msg) => {
      await Promise.all(
        this.spacesForReader(accountId, msg.chatId).map((space) =>
          this.inOrder(`${space}:${msg.chatId}`, () => this.handleEdit(space, msg)),
        ),
      );
    },
    onDelete: async (accountId, chatId, ids) => {
      await Promise.all(
        this.spacesForReader(accountId, chatId).map((space) =>
          this.inOrder(`${space}:${chatId}`, () => this.handleDelete(space, chatId, ids)),
        ),
      );
    },
    onChatSeen: (accountId, chat) =>
      this.store
        .upsertDiscoveredChat(accountId, chat)
        .catch((err) => console.error('[engine] could not record discovered chat:', err)),
    onTopicSeen: async (accountId, chatId, topicId, title) => {
      const account = this.accountsById.get(accountId);
      if (!account) return; // topics are recorded for the space of the bot that saw them
      await this.store
        .noteForumTopic(spaceOf(account), chatId, topicId, title)
        .catch((err) => console.error('[engine] could not record forum topic:', err));
    },
    onChatMigrated: async (oldChatId, newChatId) => {
      try {
        await this.store.migrateChatId(oldChatId, newChatId);
        await this.reload();
        console.log(`[engine] group ${oldChatId} upgraded to supergroup ${newChatId}`);
      } catch (err) {
        console.error('[engine] could not follow group upgrade:', err);
      }
    },
  };

  constructor(
    private store: Store,
    options: EngineOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  registerTransport(t: Transport): void {
    this.transports.set(t.accountId, t);
  }

  transport(accountId: string): Transport | undefined {
    return this.transports.get(accountId);
  }

  async init(): Promise<void> {
    await this.reload();
    this.unsubscribe = this.store.onConfigChange(() => void this.reload());
  }

  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    for (const { timer } of this.albumBuffer.values()) clearTimeout(timer);
    this.albumBuffer.clear();
  }

  async reload(): Promise<void> {
    this.cfg = await this.store.loadConfig();
    this.mastersBySpace.clear();
    this.accountsById.clear();
    this.channelsById.clear();
    this.routesByMaster.clear();
    this.routesById.clear();
    for (const a of this.cfg.accounts) this.accountsById.set(a.id, a);
    for (const ch of this.cfg.channels) {
      this.channelsById.set(ch.id, ch);
      if (ch.role === 'master' && ch.tgChatId) {
        const masters = this.mastersBySpace.get(spaceOf(ch)) ?? new Map<string, Channel>();
        masters.set(ch.tgChatId, ch);
        this.mastersBySpace.set(spaceOf(ch), masters);
      }
    }
    for (const r of this.cfg.routes) {
      this.routesById.set(r.id, r);
      const list = this.routesByMaster.get(r.masterId) ?? [];
      list.push(r);
      this.routesByMaster.set(r.masterId, list);
    }
    this.accessByChat.clear();
    for (const a of this.cfg.chatAccess ?? []) {
      const perAccount = this.accessByChat.get(a.tgChatId) ?? new Map();
      perAccount.set(a.accountId, { canRead: a.canRead, canPost: a.canPost });
      this.accessByChat.set(a.tgChatId, perAccount);
    }
  }

  get config(): RelayConfig {
    return this.cfg;
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  /**
   * The spaces a message feeds: only the space of the account that received
   * it — a client's bot never feeds another client's routes, even when both
   * relay the same channel. The simulator (tests/demo) feeds every space.
   */
  private spacesForReader(accountId: string | undefined, chatId: string): string[] {
    const transport = accountId ? this.transports.get(accountId) : undefined;
    const account = accountId ? this.accountsById.get(accountId) : undefined;
    if (account && transport?.kind !== 'sim') return [spaceOf(account)];
    if (!accountId || transport?.kind === 'sim') {
      return [...this.mastersBySpace.entries()].filter(([, m]) => m.has(chatId)).map(([space]) => space);
    }
    return []; // a bot of a disabled or removed space
  }

  async ingest(msg: RelayMessage): Promise<void> {
    await Promise.all(
      this.spacesForReader(msg.readerAccountId, msg.chatId).map((space) => this.ingestFor(space, msg)),
    );
  }

  private async ingestFor(space: string, msg: RelayMessage): Promise<void> {
    // two bots of the same space in one chat both report the post: once per space
    const key = `${space}:${msg.chatId}:${msg.messageId}`;
    if (this.seen.has(key)) return;
    this.remember(key);
    // our own delivery surfacing in a chat that is also a master (A → B → A)
    if (this.sentByUs.has(`${msg.chatId}:${msg.messageId}`)) return;

    const chain = `${space}:${msg.chatId}`;
    if (msg.albumKey) {
      const bufKey = `${space}:${msg.chatId}:${msg.albumKey}`;
      const flush = (): void => {
        const group = this.albumBuffer.get(bufKey);
        this.albumBuffer.delete(bufKey);
        if (group) {
          const ordered = group.msgs.sort((a, b) => a.messageId - b.messageId);
          void this.inOrder(chain, () => this.processGroup(space, ordered));
        }
      };
      const existing = this.albumBuffer.get(bufKey);
      if (existing) {
        existing.msgs.push(msg);
        clearTimeout(existing.timer);
        const capLeft = this.opts.albumMaxWaitMs - (Date.now() - existing.firstAt);
        existing.timer = setTimeout(flush, Math.max(0, Math.min(this.opts.albumWaitMs, capLeft)));
        existing.timer.unref?.();
        return;
      }
      const timer = setTimeout(flush, this.opts.albumWaitMs);
      timer.unref?.();
      this.albumBuffer.set(bufKey, { msgs: [msg], timer, firstAt: Date.now() });
      return;
    }

    await this.inOrder(chain, () => this.processGroup(space, [msg]));
  }

  /** Does this post belong to the forum topic the route listens to? */
  private static topicMatches(route: Route, msg: RelayMessage): boolean {
    if (route.sourceTopicId == null) return true; // whole chat
    return (msg.topicId ?? null) === route.sourceTopicId;
  }

  /**
   * Run `work` after everything already queued for this master. With
   * immediate delivery, unordered processing could let "SL moved" overtake
   * "BUY" on its way to a receiver, or an edit arrive before its post exists.
   */
  private inOrder(masterChatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.masterChains.get(masterChatId) ?? Promise.resolve();
    const next = previous.then(work).catch((err) => {
      console.error(`[engine] processing an update from ${masterChatId} failed:`, err);
    });
    this.masterChains.set(masterChatId, next);
    void next.then(() => {
      if (this.masterChains.get(masterChatId) === next) this.masterChains.delete(masterChatId);
    });
    return next;
  }

  private rememberSent(chatId: string, messageIds: number[]): void {
    for (const id of messageIds) {
      const key = `${chatId}:${id}`;
      this.sentByUs.add(key);
      this.sentByUsOrder.push(key);
    }
    while (this.sentByUsOrder.length > 10_000) {
      const oldest = this.sentByUsOrder.shift();
      if (oldest) this.sentByUs.delete(oldest);
    }
  }

  private remember(key: string): void {
    this.seen.add(key);
    this.seenOrder.push(key);
    if (this.seenOrder.length > 10_000) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }

  private contextFor(master: Channel, msg: RelayMessage, route?: Route): PipelineContext {
    return {
      masterTitle: master.title,
      masterUsername: master.username,
      messageLink: master.username
        ? `https://t.me/${master.username}/${msg.messageId}`
        : undefined,
      now: this.opts.clock(),
      // {date}/{time} variables render in the route's schedule timezone
      tz: route?.schedule?.tz,
    };
  }

  private async processGroup(space: string, msgs: RelayMessage[]): Promise<void> {
    const first = msgs[0];
    if (!first) return;
    const master = this.mastersBySpace.get(space)?.get(first.chatId);
    if (!master || !master.enabled) return;

    this.touchMaster(master.id);

    // The album's caption lives on whichever item has text.
    const primary = msgs.find((m) => m.text.text.length > 0) ?? first;
    const now = this.opts.clock();

    // Receivers are independent: fan out in parallel, so the 10th receiver
    // doesn't wait for nine sequential database writes and sends.
    await Promise.all(
      (this.routesByMaster.get(master.id) ?? []).map((route) =>
        this.processRoute(route, master, msgs, primary, now).catch((err) => {
          console.error(`[engine] route ${route.id} failed to process a post:`, err);
        }),
      ),
    );
  }

  private async processRoute(
    route: Route,
    master: Channel,
    msgs: RelayMessage[],
    primary: RelayMessage,
    now: Date,
  ): Promise<void> {
    if (!route.enabled) return;
    // a topic route ignores the rest of the forum — silently, no dropped rows
    if (!RelayEngine.topicMatches(route, primary)) return;
    const receiver = this.channelsById.get(route.receiverId);
    if (!receiver || !receiver.enabled || !receiver.tgChatId) return;

    const first = msgs[0]!;
    const base = {
      routeId: route.id,
      masterChannelId: master.id,
      receiverChannelId: receiver.id,
      srcMessageId: first.messageId,
      srcMessageIds: msgs.map((m) => m.messageId),
      albumKey: first.albumKey,
      kind: 'post' as const,
      mediaKind: primary.media,
    };

    const result = applyRules(primary, this.rulesFor(route), this.contextFor(master, primary, route));
    if (result.action === 'drop') {
      await this.store.upsertForward({
        ...base,
        state: 'dropped',
        dropReason: result.reason,
        deliverAt: now,
        preview: primary.text.text.slice(0, 200),
      });
      return;
    }
    // A text post the rules stripped bare (e.g. a message that was only a link)
    // has nothing to send — Telegram rejects empty messages.
    if (msgs.length === 1 && primary.media === 'text' && result.output.text.trim().length === 0) {
      await this.store.upsertForward({
        ...base,
        state: 'dropped',
        dropReason: "nothing left to send after this route's transforms",
        deliverAt: now,
        preview: primary.text.text.slice(0, 200),
      });
      return;
    }

    const timing = resolveTiming(now, route.delaySeconds, route.schedule, route.pausedUntil);
    if (timing.action === 'drop') {
      await this.store.upsertForward({
        ...base,
        state: 'dropped',
        dropReason: timing.reason,
        deliverAt: now,
        preview: result.output.text.slice(0, 200),
      });
      return;
    }

    const payload: ForwardPayload = {
      srcText: primary.text,
      output: result.output,
      removeButtons: result.removeButtons,
      ...(msgs.length > 1
        ? {
            items: msgs.map((m) => ({
              messageId: m.messageId,
              media: m.media,
              fileId: m.fileId,
              fileAccountId: m.readerAccountId,
              hasSpoiler: m.hasSpoiler,
            })),
          }
        : {}),
    };

    await this.persistAndDeliver(
      {
        ...base,
        state: timing.action === 'send' ? 'queued' : timing.held ? 'held' : 'scheduled',
        deliverAt: timing.action === 'send' ? now : timing.deliverAt,
        preview: result.output.text.slice(0, 200),
        payload,
      },
      now,
    );
  }

  /**
   * Persist a forward; when it is due now and immediate delivery is on, it is
   * written straight as `sending` (so no sender-loop claim can race it) and
   * delivered in-process. A crash in between leaves a stale `sending` row,
   * which the reaper parks as unconfirmed — never silently re-sent.
   */
  private async persistAndDeliver(record: NewForward, now: Date): Promise<void> {
    const immediate =
      this.opts.immediateDelivery &&
      record.state === 'queued' &&
      record.deliverAt.getTime() <= now.getTime();
    const stored: NewForward = immediate ? { ...record, state: 'sending' } : record;

    const { id, deduped } = await this.store.upsertForward(stored);
    if (!immediate || deduped || !id) return;
    await this.deliver({ ...stored, id, attempts: stored.attempts ?? 0, createdAt: now });
  }

  /** last_message_at + master_silent resolution: off the hot path, throttled. */
  private touchMaster(masterId: string): void {
    const nowMs = Date.now();
    if (nowMs - (this.lastMasterTouch.get(masterId) ?? 0) < 30_000) return;
    this.lastMasterTouch.set(masterId, nowMs);
    const at = this.opts.clock();
    void Promise.all([
      this.store.setChannelLastMessage(masterId, at),
      this.store.resolveIncidents('master_silent', { channelId: masterId }),
    ]).catch((err) => console.error('[engine] master bookkeeping failed:', err));
  }

  // ── edits & deletes ───────────────────────────────────────────────────────

  async handleEdit(space: string, msg: RelayMessage): Promise<void> {
    const master = this.mastersBySpace.get(space)?.get(msg.chatId);
    if (!master || !master.enabled) return;
    const now = this.opts.clock();

    for (const route of this.routesByMaster.get(master.id) ?? []) {
      if (!route.enabled || !route.syncEdits || route.mode !== 'copy') continue;
      if (!RelayEngine.topicMatches(route, msg)) continue;
      const post = await this.store.findPost(route.id, msg.messageId);
      if (!post) continue;

      const result = applyRules(msg, this.rulesFor(route), this.contextFor(master, msg, route));

      // The post hasn't reached the receiver yet (delay, schedule, retry
      // backoff, in flight): refresh it in place so the edited content is
      // what eventually goes out — an edit must never be silently lost.
      if (post.state === 'queued' || post.state === 'scheduled' || post.state === 'held') {
        if (result.action === 'drop') {
          await this.store.updateForward(post.id, {
            state: 'dropped',
            dropReason: `edited into filtered content: ${result.reason}`,
          });
        } else {
          await this.store.updateForward(post.id, {
            payload: {
              srcText: msg.text,
              output: result.output,
              removeButtons: result.removeButtons,
            },
            preview: result.output.text.slice(0, 200),
          });
        }
        continue;
      }

      if (post.state !== 'done' || !post.destMessageIds?.length) continue;
      if (result.action === 'drop') continue; // edited into filtered content — leave the copy
      // an edit that leaves a text post empty can't be applied — leave the copy
      if (msg.media === 'text' && result.output.text.trim().length === 0) continue;

      const payload: ForwardPayload = {
        srcText: msg.text,
        output: result.output,
        removeButtons: result.removeButtons,
      };
      await this.persistAndDeliver(
        {
          routeId: route.id,
          masterChannelId: master.id,
          receiverChannelId: post.receiverChannelId,
          srcMessageId: msg.messageId,
          kind: 'edit',
          senderAccountId: post.senderAccountId,
          state: 'queued',
          deliverAt: now,
          destMessageIds: post.destMessageIds,
          mediaKind: msg.media,
          preview: result.output.text.slice(0, 200),
          payload,
        },
        now,
      );
    }
  }

  async handleDelete(space: string, chatId: string, messageIds: number[]): Promise<void> {
    const master = this.mastersBySpace.get(space)?.get(chatId);
    if (!master) return;
    const now = this.opts.clock();

    for (const route of this.routesByMaster.get(master.id) ?? []) {
      if (!route.syncDeletes || route.mode !== 'copy') continue;
      for (const srcId of messageIds) {
        const post = await this.store.findPost(route.id, srcId);
        if (!post) continue;

        // Deleted at the source before we ever sent it — cancel the pending
        // post instead of relaying content its author already retracted.
        if (post.state === 'queued' || post.state === 'scheduled' || post.state === 'held') {
          await this.store.updateForward(post.id, {
            state: 'dropped',
            dropReason: 'deleted at the source before sending',
          });
          continue;
        }

        if (post.state !== 'done' || !post.destMessageIds?.length) continue;
        await this.persistAndDeliver(
          {
            routeId: route.id,
            masterChannelId: master.id,
            receiverChannelId: post.receiverChannelId,
            srcMessageId: srcId,
            kind: 'delete',
            senderAccountId: post.senderAccountId,
            state: 'queued',
            deliverAt: now,
            destMessageIds: post.destMessageIds,
          },
          now,
        );
      }
    }
  }

  // ── catch-up after downtime ───────────────────────────────────────────────

  async catchUp(): Promise<void> {
    const windowBySpace = new Map<string, number>();
    for (const master of this.cfg.channels) {
      if (master.role !== 'master' || !master.enabled || !master.tgChatId) continue;
      const space = spaceOf(master);
      if (!windowBySpace.has(space)) {
        const settings = await this.store.getAppSettings(space).catch(() => null);
        windowBySpace.set(space, settings?.catchupWindowMinutes ?? 0);
      }
      const minutes = windowBySpace.get(space)!;
      if (minutes <= 0) continue;
      const since = Math.floor(this.opts.clock().getTime() / 1000) - minutes * 60;

      const reader = this.pickReader(master);
      if (!reader) continue;
      try {
        const missed = await reader.history(master.tgChatId, since);
        // feed only the space this master (and its reader) belongs to
        for (const msg of missed) await this.ingestFor(space, { ...msg, readerAccountId: reader.accountId });
      } catch {
        // history is best-effort; live updates keep flowing regardless
      }
    }
  }

  // ── delivery ──────────────────────────────────────────────────────────────

  /** One sender-loop iteration. Returns how many rows it attempted. */
  async tick(): Promise<number> {
    const now = this.opts.clock();
    await this.reapStaleSending(now);
    const due = await this.store.claimDue(now, 20);
    for (const f of due) await this.deliver(f);
    return due.length;
  }

  private lastReapAt = 0;

  /**
   * A row stuck in `sending` means the worker died (or lost storage) between
   * the Telegram call and the completion write — the send MAY have gone
   * through, so requeueing would risk a duplicate post. Park it as failed
   * with a clear note; the operator can verify in Telegram and retry by hand.
   */
  private async reapStaleSending(now: Date): Promise<void> {
    if (now.getTime() - this.lastReapAt < 60_000) return;
    this.lastReapAt = now.getTime();
    try {
      const parked = await this.store.parkStaleSending(
        new Date(now.getTime() - this.opts.staleSendingSeconds * 1000),
        'delivery unconfirmed — the worker was interrupted mid-send; check the receiver channel before retrying',
      );
      for (const { spaceId, count } of parked) {
        console.warn(`[engine] parked ${count} unconfirmed forward(s) stuck in sending`);
        await this.store.notify(
          'worker',
          'Unconfirmed deliveries',
          `${count} forward(s) were interrupted mid-send and parked as failed. Check the receiver channel before retrying them.`,
          undefined,
          spaceId,
        );
      }
    } catch (err) {
      console.error('[engine] stale-sending reap failed:', err);
    }
  }

  /** A connected reader of the master's own space — preferring one that is in the chat. */
  private pickReader(master: Channel): Transport | undefined {
    const space = spaceOf(master);
    const readers = this.cfg.accounts.filter(
      (a) => spaceOf(a) === space && a.isReader && a.status === 'connected' && this.transports.has(a.id),
    );
    const chosen = readers.find((a) => this.canAccess(a.id, master)) ?? readers[0];
    if (chosen) return this.transports.get(chosen.id);
    return [...this.transports.values()].find((t) => t.kind === 'sim');
  }

  /** Discovery says this account can post in the receiver (or a user-account membership does). */
  private canPostTo(accountId: string, receiver: Channel): boolean {
    if (this.cfg.memberships.some((m) => m.accountId === accountId && m.channelId === receiver.id && m.canPost)) {
      return true;
    }
    return Boolean(receiver.tgChatId && this.accessByChat.get(receiver.tgChatId)?.get(accountId)?.canPost);
  }

  /** The account is in the master, so it can copy or forward that chat's posts. */
  private canAccess(accountId: string, master: Channel): boolean {
    if (this.cfg.memberships.some((m) => m.accountId === accountId && m.channelId === master.id && m.isMember)) {
      return true;
    }
    return Boolean(master.tgChatId && this.accessByChat.get(master.tgChatId)?.has(accountId));
  }

  /**
   * Who posts this forward. With several bots (or accounts) able to post to the
   * receiver, the load is spread: prefer whoever can send right now without
   * hitting a Telegram rate limit, then whoever sent least in the last minute.
   * Pinned cases skip balancing: the route names a sender, or the message
   * being edited / deleted / resumed was sent by a specific account.
   */
  private pickSender(
    route: Route,
    receiver: Channel,
    master: Channel,
    opts: { needsSourceAccess: boolean; stickyAccountId?: string; fileAccountId?: string },
  ): Transport | undefined {
    const space = spaceOf(route);
    const connected = (id: string | null | undefined): Transport | undefined => {
      if (!id) return undefined;
      const account = this.accountsById.get(id);
      const transport = this.transports.get(id);
      if (!account) return transport?.kind === 'sim' ? transport : undefined;
      if (account.status !== 'connected' || spaceOf(account) !== space) return undefined;
      return transport;
    };
    const pinned = connected(route.senderAccountId) ?? connected(opts.stickyAccountId);
    if (pinned) return pinned;

    const able = this.cfg.accounts
      .filter((a) => spaceOf(a) === space && a.isSender && a.status === 'connected' && this.transports.has(a.id))
      .filter((a) => this.canPostTo(a.id, receiver))
      .filter((a) => !opts.needsSourceAccess || this.canAccess(a.id, master));
    // Automatic sharing stays among bots: a user account posts under another
    // identity (its own, or the group's), so it only sends when a route names
    // it or no bot can.
    const bots = able.filter((a) => a.kind === 'bot');
    const eligible = (bots.length > 0 ? bots : able).map((a) => this.transports.get(a.id)!);

    if (eligible.length > 0) {
      const now = this.opts.clock().getTime();
      const ranked = eligible.map((t, order) => ({ t, order, ...this.pacingPeek(t, receiver.id, now) }));
      ranked.sort(
        (a, b) =>
          a.delay - b.delay ||
          // the reader of an album holds its file ids: one grouped send, no caption edit
          Number(b.t.accountId === opts.fileAccountId) - Number(a.t.accountId === opts.fileAccountId) ||
          a.load - b.load ||
          Number(b.t.kind === 'bot') - Number(a.t.kind === 'bot') ||
          a.order - b.order,
      );
      return ranked[0]!.t;
    }

    // No rights known yet (e.g. just connected): any connected sender OF THIS SPACE, bots first, then the simulator.
    const fallback = this.cfg.accounts
      .filter((acc) => spaceOf(acc) === space && acc.isSender && acc.status === 'connected')
      .sort((a, b) => Number(b.kind === 'bot') - Number(a.kind === 'bot'));
    for (const acc of fallback) {
      const t = this.transports.get(acc.id);
      if (t) return t;
    }
    return [...this.transports.values()].find((t) => t.kind === 'sim');
  }

  /**
   * Rules a route runs on: its preset's when it uses one (edit the preset,
   * every linked route follows), otherwise its own. A preset from another
   * space is never applied.
   */
  private rulesFor(route: Route): RouteRules {
    if (!route.presetId) return route.rules;
    const preset = (this.cfg.presets ?? []).find((p) => p.id === route.presetId);
    if (!preset || spaceOf(preset) !== spaceOf(route)) return route.rules;
    return preset.rules;
  }

  private ratePerMinute(accountId: string): number {
    return this.cfg.accounts.find((a) => a.id === accountId)?.maxMsgsPerMinute ?? 20;
  }

  /**
   * Sliding-window rate limits that allow bursts: a post is only held back
   * once a window is actually full, so normal traffic is never delayed.
   * - per sender per receiver: Telegram's per-chat limit applies to each bot
   *   separately (~20/min in groups) — which is why more bots = more capacity
   * - per sender: bots ~25/s; user accounts a conservative per-minute budget
   */
  private pacingWindows(sender: Transport, receiverId: string): [key: string, limit: number, spanMs: number][] {
    const perMinute = this.ratePerMinute(sender.accountId);
    return [
      [`receiver:${sender.accountId}:${receiverId}`, perMinute, 60_000],
      sender.kind === 'bot'
        ? [`account:${sender.accountId}`, BOT_MSGS_PER_SECOND, 1_000]
        : [`account:${sender.accountId}`, perMinute * 4, 60_000],
    ];
  }

  /** How long this sender would have to wait, and how busy it has been — without recording a send. */
  private pacingPeek(sender: Transport, receiverId: string, now: number): { delay: number; load: number } {
    if (sender.kind === 'sim') return { delay: 0, load: 0 };
    let delay = 0;
    for (const [key, limit, spanMs] of this.pacingWindows(sender, receiverId)) {
      const recent = (this.sendWindows.get(key) ?? []).filter((t) => t > now - spanMs);
      if (recent.length >= limit) delay = Math.max(delay, recent[0]! + spanMs - now);
    }
    const load = (this.sendWindows.get(`load:${sender.accountId}`) ?? []).filter((t) => t > now - 60_000).length;
    return { delay, load };
  }

  /**
   * Check-and-record in one synchronous step, so parallel deliveries can't
   * overshoot a limit. Returns the wait in ms (0 = send now, and it's recorded).
   */
  private pacingDelay(sender: Transport, receiverId: string, now: number): number {
    if (sender.kind === 'sim') return 0; // no real limits to respect
    const windows = this.pacingWindows(sender, receiverId);
    let delay = 0;
    for (const [key, limit, spanMs] of windows) {
      const recent = (this.sendWindows.get(key) ?? []).filter((t) => t > now - spanMs);
      this.sendWindows.set(key, recent);
      if (recent.length >= limit) delay = Math.max(delay, recent[0]! + spanMs - now);
    }
    if (delay === 0) {
      for (const [key] of windows) this.sendWindows.get(key)!.push(now);
      const loadKey = `load:${sender.accountId}`;
      const load = (this.sendWindows.get(loadKey) ?? []).filter((t) => t > now - 60_000);
      load.push(now);
      this.sendWindows.set(loadKey, load);
    }
    return delay;
  }

  private async deliver(f: ForwardRecord): Promise<void> {
    const route = this.routesById.get(f.routeId);
    const receiver = this.channelsById.get(f.receiverChannelId);
    const master = this.channelsById.get(f.masterChannelId);
    if (!route || !receiver?.tgChatId || !master?.tgChatId) {
      await this.store.updateForward(f.id, { state: 'failed', lastError: 'route or channel removed' });
      return;
    }
    if (!route.enabled || !receiver.enabled) {
      await this.store.updateForward(f.id, { state: 'dropped', dropReason: 'route disabled' });
      return;
    }

    const payloadItems = (f.payload as ForwardPayload | undefined)?.items;
    const sender = this.pickSender(route, receiver, master, {
      // copying media or forwarding reads the source post; plain text does not
      needsSourceAccess:
        f.kind === 'post' && (route.mode === 'forward' || (f.mediaKind ?? 'text') !== 'text'),
      // edits, deletes and half-sent albums must stay with the account that posted them
      stickyAccountId: f.kind !== 'post' || f.destMessageIds?.length ? f.senderAccountId : undefined,
      fileAccountId: payloadItems?.[0]?.fileAccountId,
    });
    if (!sender) {
      await this.store.updateForward(f.id, {
        state: 'failed',
        lastError: 'no connected sender account can post to this receiver',
      });
      return;
    }

    const now = this.opts.clock().getTime();
    const wait = this.pacingDelay(sender, receiver.id, now);
    if (wait > 0) {
      await this.store.updateForward(f.id, { state: 'queued', deliverAt: new Date(now + wait) });
      return;
    }

    const payload = f.payload as ForwardPayload | undefined;

    // Only the Telegram call itself may route into handleDeliveryError.
    // Once Telegram has accepted the send, a storage hiccup must never
    // requeue the row — that would double-post it.
    let done: Partial<ForwardRecord>;
    try {
      if (f.kind === 'delete') {
        await sender.deleteMessages(receiver.tgChatId, f.destMessageIds ?? []);
        done = {};
      } else if (f.kind === 'edit') {
        const target = f.destMessageIds?.[0];
        if (target === undefined || !payload) {
          await this.store.updateForward(f.id, { state: 'failed', lastError: 'missing edit target' });
          return;
        }
        await sender.editCopy(receiver.tgChatId, target, payload.output, f.mediaKind ?? 'text');
        done = {};
      } else {
        const destIds = await this.sendPost(f, route, master, receiver, sender, payload);
        this.rememberSent(receiver.tgChatId, destIds);
        done = {
          destMessageIds: destIds,
          // the simulator has no telegram_accounts row — its literal id
          // must never reach the uuid column
          senderAccountId: sender.kind === 'sim' ? undefined : sender.accountId,
          latencyMs: this.opts.clock().getTime() - f.createdAt.getTime(),
        };
      }
    } catch (err) {
      await this.handleDeliveryError(f, route, master, receiver, err);
      return;
    }

    await this.confirmDelivered(f.id, done);

    // Recovery bookkeeping only when something was actually wrong — a healthy
    // receiver must not pay two extra database round trips per message.
    const recovering = this.consecutiveFails.has(route.id) || receiver.health !== 'ok';
    this.consecutiveFails.delete(route.id);
    if (!recovering) return;
    try {
      await this.store.setChannelHealth(receiver.id, 'ok');
      await this.store.resolveIncidents('receiver_no_permission', { channelId: receiver.id });
      receiver.health = 'ok';
    } catch (err) {
      // Bookkeeping only — never let it disturb a delivered forward.
      console.error('[engine] post-delivery bookkeeping failed:', err);
    }
  }

  /**
   * Persist the terminal `done` state after a successful Telegram send.
   * Retries a few times; if storage stays down, the row remains `sending`
   * and the stale-sending reaper parks it as unconfirmed — it is NEVER
   * requeued, because the post is already out.
   */
  private async confirmDelivered(id: string, patch: Partial<ForwardRecord>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.store.updateForward(id, { ...patch, state: 'done' });
        return;
      } catch (err) {
        if (attempt === 2) {
          console.error(`[engine] forward ${id} delivered but completion write kept failing:`, err);
          return;
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  private async sendPost(
    f: ForwardRecord,
    route: Route,
    master: Channel,
    receiver: Channel,
    sender: Transport,
    payload: ForwardPayload | undefined,
  ): Promise<number[]> {
    const srcAll = f.srcMessageIds?.length ? f.srcMessageIds : [f.srcMessageId];

    // Album resume: items delivered on a previous attempt (Bot API sends
    // albums item by item and can fail mid-loop) are checkpointed into
    // dest_message_ids as they land, and never re-sent on retry.
    const already = f.destMessageIds ?? [];
    const skip = already.length;
    if (skip >= srcAll.length) return already; // everything already went out
    const srcIds = skip > 0 ? srcAll.slice(skip) : srcAll;

    const checkpoint = async (sentSoFar: number[]) => {
      try {
        await this.store.updateForward(f.id, {
          destMessageIds: [...already, ...sentSoFar],
          // a resume must use this same account
          ...(sender.kind !== 'sim' ? { senderAccountId: sender.accountId } : {}),
        });
      } catch {
        // best-effort: a lost checkpoint at worst re-sends one album item
      }
    };

    const items = payload?.items;
    const common = {
      toChatId: receiver.tgChatId!,
      silent: route.silent,
      mediaKind: f.mediaKind ?? 'text',
      items: items && skip > 0 ? items.slice(skip) : items,
      topicId: route.targetTopicId ?? null,
      onSent: checkpoint,
      // The transformed caption belongs to the album's first item; on a
      // resume that item is already out, so nothing gets re-captioned.
      applyCaption: skip === 0,
    };

    if (route.mode === 'forward') {
      const sent = await sender.forward({ ...common, fromChatId: master.tgChatId!, srcMessageIds: srcIds });
      return [...already, ...sent];
    }

    const output = payload?.output ?? { text: '', entities: [] };
    const removeButtons = payload?.removeButtons ?? false;

    // Bot fan-out: media goes master → buffer once (via a reader), then the
    // bot copies buffer → receiver. Pure text needs no buffer at all.
    if (route.useFanout && sender.kind === 'bot' && (f.mediaKind ?? 'text') !== 'text') {
      const buffer = this.cfg.channels.find((c) => c.role === 'buffer' && c.enabled && c.tgChatId);
      if (buffer?.tgChatId) {
        const bufKey = `${master.id}:${f.srcMessageId}`;
        let bufIds = this.bufferCopies.get(bufKey);
        if (!bufIds) {
          const reader = this.pickReader(master);
          if (reader) {
            // Always copy the FULL album into the buffer so cached buffer ids
            // stay 1:1 with the source list even when a resume skips items.
            bufIds = await reader.copy({
              fromChatId: master.tgChatId!,
              srcMessageIds: srcAll,
              toChatId: buffer.tgChatId,
              text: payload?.srcText ?? output,
              silent: true,
              removeButtons: true,
              mediaKind: f.mediaKind ?? 'text',
            });
            this.bufferCopies.set(bufKey, bufIds);
            if (this.bufferCopies.size > 2000) {
              const first = this.bufferCopies.keys().next().value;
              if (first) this.bufferCopies.delete(first);
            }
          }
        }
        if (bufIds) {
          const sent = await sender.copy({
            ...common,
            fromChatId: buffer.tgChatId,
            srcMessageIds: skip > 0 ? bufIds.slice(skip) : bufIds,
            text: output,
            removeButtons,
          });
          return [...already, ...sent];
        }
      }
    }

    const sent = await sender.copy({
      ...common,
      fromChatId: master.tgChatId!,
      srcMessageIds: srcIds,
      text: output,
      removeButtons,
    });
    return [...already, ...sent];
  }

  private async handleDeliveryError(
    f: ForwardRecord,
    route: Route,
    master: Channel,
    receiver: Channel,
    err: unknown,
  ): Promise<void> {
    const e =
      err instanceof TransportError ? err : new TransportError('unknown', String(err));
    const now = this.opts.clock();

    if (e.code === 'flood_wait') {
      const wait = Math.max(1, e.retryAfterSeconds);
      await this.store.updateForward(f.id, {
        state: 'scheduled',
        deliverAt: new Date(now.getTime() + wait * 1000),
        lastError: `FLOOD_WAIT ${wait}s`,
      });
      if (wait > 60) {
        const { isNew, id } = await this.store.openIncident(
          'flood_wait',
          { channelId: receiver.id },
          `Telegram asked us to wait ${wait}s before posting to ${receiver.title}`,
        );
        if (isNew) await this.store.notify('flood_wait', 'Rate limited', `Waiting ${wait}s for ${receiver.title}`, id);
      }
      return;
    }

    if (e.code === 'protected') {
      await this.store.updateForward(f.id, {
        state: 'dropped',
        dropReason: 'protected content — the master forbids copying',
      });
      await this.store.setChannelHealth(master.id, 'protected');
      const { isNew, id } = await this.store.openIncident(
        'protected_content',
        { channelId: master.id },
        `${master.title} restricts saving content; its posts cannot be relayed`,
      );
      if (isNew) {
        await this.store.notify('protected_content', 'Non-forwardable master', `${master.title} has protected content enabled.`, id);
      }
      return;
    }

    // Telegram refused this one message (source deleted, unsupported content,
    // quiz poll, paid media…). Fail it now; the route and receiver are fine.
    if (e.code === 'rejected') {
      await this.store.updateForward(f.id, {
        state: 'failed',
        attempts: f.attempts + 1,
        lastError: `Telegram rejected this message: ${e.message}`,
      });
      return;
    }

    if (e.code === 'session_revoked') {
      await this.store.updateForward(f.id, {
        state: 'queued',
        deliverAt: new Date(now.getTime() + 300_000),
        lastError: 'sender session revoked',
      });
      return;
    }

    const attempts = f.attempts + 1;
    const isPermission = e.code === 'forbidden' || e.code === 'not_found';
    const exhausted = attempts >= this.opts.maxAttempts;

    if (isPermission || exhausted) {
      await this.store.updateForward(f.id, {
        state: 'failed',
        attempts,
        lastError: e.message,
      });
      if (isPermission) {
        const fails = (this.consecutiveFails.get(route.id) ?? 0) + 1;
        this.consecutiveFails.set(route.id, fails);
        await this.store.setChannelHealth(
          receiver.id,
          e.code === 'not_found' ? 'unavailable' : 'no_permission',
          e.message,
        );
        const { isNew, id } = await this.store.openIncident(
          'receiver_no_permission',
          { channelId: receiver.id },
          `Cannot post to ${receiver.title}: ${e.message}`,
        );
        if (isNew) {
          await this.store.notify('receiver_no_permission', 'Receiver unreachable', `Cannot post to ${receiver.title}.`, id);
        }
        if (fails >= this.opts.autopauseAfter) {
          await this.store.disableRoute(route.id);
          route.enabled = false;
          const paused = await this.store.openIncident(
            'route_autopaused',
            { routeId: route.id, channelId: receiver.id },
            `Route to ${receiver.title} paused after ${fails} consecutive failures`,
          );
          if (paused.isNew) {
            await this.store.notify('route_autopaused', 'Route auto-paused', `${master.title} → ${receiver.title} was paused after repeated failures.`, paused.id);
          }
        }
      }
      return;
    }

    const backoff =
      this.opts.backoffSeconds[Math.min(attempts - 1, this.opts.backoffSeconds.length - 1)] ?? 60;
    await this.store.updateForward(f.id, {
      state: 'queued',
      attempts,
      deliverAt: new Date(now.getTime() + backoff * 1000),
      lastError: e.message,
    });
  }
}
