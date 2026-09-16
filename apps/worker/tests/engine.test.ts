import { beforeEach, describe, expect, it } from 'vitest';
import { parseRouteRules, parseRouteSchedule } from '@pierre/core';
import { RelayEngine } from '../src/engine';
import { MemoryStore } from '../src/store/memory-store';
import { SimTransport } from '../src/transport/sim';
import { TransportError, type SendOptions, type Transport } from '../src/transport/transport';
import type { RelayConfig, Route } from '../src/model';

const MASTER_TG = '-100111';
const RECEIVER1_TG = '-100222';
const RECEIVER2_TG = '-100333';

let store: MemoryStore;
let sim: SimTransport;
let engine: RelayEngine;
let nowMs: number;

const clock = () => new Date(nowMs);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseRoute = (over: Partial<Route> = {}): Route => ({
  id: 'rt1',
  masterId: 'm1',
  receiverId: 'r1',
  enabled: true,
  mode: 'copy',
  silent: false,
  senderAccountId: null,
  useFanout: false,
  delaySeconds: 0,
  schedule: null,
  pausedUntil: null,
  syncEdits: true,
  syncDeletes: true,
  rules: parseRouteRules({}),
  ...over,
});

const baseConfig = (): RelayConfig => ({
  accounts: [
    {
      id: 'acc-sim',
      kind: 'user',
      label: 'Sim reader',
      status: 'connected',
      isReader: true,
      isSender: true,
      isAlertSender: false,
      maxMsgsPerMinute: 1800,
    },
  ],
  channels: [
    {
      id: 'm1',
      role: 'master',
      tgChatId: MASTER_TG,
      title: 'Gold Signals',
      username: 'goldsig',
      enabled: true,
      health: 'ok',
      isProtected: false,
    },
    { id: 'r1', role: 'receiver', tgChatId: RECEIVER1_TG, title: 'VIP Room', enabled: true, health: 'ok', isProtected: false },
    { id: 'r2', role: 'receiver', tgChatId: RECEIVER2_TG, title: 'Second Room', enabled: true, health: 'ok', isProtected: false },
  ],
  memberships: [
    { accountId: 'acc-sim', channelId: 'm1', isMember: true, isAdmin: false, canPost: false, canEdit: false, canDelete: false },
    { accountId: 'acc-sim', channelId: 'r1', isMember: true, isAdmin: true, canPost: true, canEdit: true, canDelete: true },
    { accountId: 'acc-sim', channelId: 'r2', isMember: true, isAdmin: true, canPost: true, canEdit: true, canDelete: true },
  ],
  routes: [baseRoute()],
});

async function setup(mutate?: (cfg: RelayConfig) => void): Promise<void> {
  nowMs = new Date('2026-09-15T10:00:00Z').getTime();
  store = new MemoryStore();
  store.config = baseConfig();
  mutate?.(store.config);
  sim = new SimTransport('acc-sim');
  engine = new RelayEngine(store, { albumWaitMs: 15, clock, autopauseAfter: 3 });
  engine.registerTransport(sim);
  await engine.init();
  await sim.start(engine.handlers);
}

/** Advance simulated time and run sender ticks until the queue settles. */
async function drain(maxIterations = 30): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    const attempted = await engine.tick();
    nowMs += 2000;
    if (attempted === 0 && (await store.countPending()) === 0) return;
  }
}

beforeEach(async () => {
  await setup();
});

describe('RelayEngine — posting', () => {
  it('relays a master post to the linked receiver', async () => {
    await sim.injectPost(MASTER_TG, 'XAUUSD buy 2650, TP 2680');
    await drain();

    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.toChatId).toBe(RECEIVER1_TG);
    expect(sim.sent[0]!.text.text).toBe('XAUUSD buy 2650, TP 2680');

    const rows = [...store.forwards.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('done');
    expect(rows[0]!.destMessageIds).toEqual(sim.sent[0]!.destMessageIds);
  });

  it('fans one master post out to several receivers', async () => {
    store.config.routes.push(baseRoute({ id: 'rt2', receiverId: 'r2' }));
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'multi fan-out');
    await drain();

    expect(sim.sent.map((s) => s.toChatId).sort()).toEqual([RECEIVER1_TG, RECEIVER2_TG]);
  });

  it('never forwards the same message twice', async () => {
    await sim.injectPost(MASTER_TG, 'once only', { messageId: 42 });
    await sim.injectPost(MASTER_TG, 'once only', { messageId: 42 });
    await drain();
    expect(sim.sent).toHaveLength(1);
  });

  it('applies route rules before sending', async () => {
    store.config.routes = [
      baseRoute({
        rules: parseRouteRules({
          replacements: [{ find: 'buy', replace: 'LONG' }],
          footer: 'via {master}',
        }),
      }),
    ];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'buy gold now');
    await drain();

    expect(sim.sent[0]!.text.text).toBe('LONG gold now\n\nvia Gold Signals');
  });

  it('records filtered messages as dropped with a reason, without sending', async () => {
    store.config.routes = [
      baseRoute({ rules: parseRouteRules({ filters: { excludeKeywords: ['promo'] } }) }),
    ];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'huge promo inside');
    await drain();

    expect(sim.sent).toHaveLength(0);
    const row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('dropped');
    expect(row.dropReason).toContain('promo');
  });

  it('groups album items into a single delivery', async () => {
    await sim.injectPost(MASTER_TG, '', { media: 'photo', albumKey: 'alb1', messageId: 10 });
    await sim.injectPost(MASTER_TG, 'album caption', { media: 'photo', albumKey: 'alb1', messageId: 11 });
    await sleep(40); // wait past albumWaitMs
    await drain();

    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.srcMessageIds).toEqual([10, 11]);
    expect(sim.sent[0]!.text.text).toBe('album caption');
  });

  it('uses native forward mode when configured', async () => {
    store.config.routes = [baseRoute({ mode: 'forward' })];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'keep the header');
    await drain();

    expect(sim.sent[0]!.native).toBe(true);
  });

  it('ignores posts from unknown or disabled masters', async () => {
    await sim.injectPost('-100999', 'not a master');
    store.config.channels[0]!.enabled = false;
    await engine.reload();
    await sim.injectPost(MASTER_TG, 'master disabled');
    await drain();
    expect(sim.sent).toHaveLength(0);
  });
});

describe('RelayEngine — timing', () => {
  it('honors a per-route delay', async () => {
    store.config.routes = [baseRoute({ delaySeconds: 60 })];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'delayed message');
    await engine.tick();
    expect(sim.sent).toHaveLength(0);
    expect([...store.forwards.values()][0]!.state).not.toBe('done');

    nowMs += 61_000;
    await drain();
    expect(sim.sent).toHaveLength(1);
  });

  it('holds messages outside the schedule window', async () => {
    // Wednesday-only window; "now" is Tuesday 10:00 UTC → held until Wednesday 08:00
    store.config.routes = [
      baseRoute({
        schedule: parseRouteSchedule({
          tz: 'UTC',
          windows: [{ dow: 3, start: '08:00', end: '18:00' }],
          offWindow: 'hold',
        }),
      }),
    ];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'held for tuesday');
    await engine.tick();
    expect(sim.sent).toHaveLength(0);
    expect([...store.forwards.values()][0]!.state).toBe('held');

    nowMs = new Date('2026-09-16T08:00:30Z').getTime(); // Wednesday, window open
    await drain();
    expect(sim.sent).toHaveLength(1);
  });

  it('drops outside the window when offWindow=drop', async () => {
    store.config.routes = [
      baseRoute({
        schedule: parseRouteSchedule({
          tz: 'UTC',
          windows: [{ dow: 3, start: '08:00', end: '18:00' }],
          offWindow: 'drop',
        }),
      }),
    ];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'weekend message');
    await drain();
    expect(sim.sent).toHaveLength(0);
    expect([...store.forwards.values()][0]!.state).toBe('dropped');
  });
});

describe('RelayEngine — failures', () => {
  it('waits out FLOOD_WAIT and then retries successfully', async () => {
    sim.failures.set(RECEIVER1_TG, { code: 'flood_wait', retryAfterSeconds: 30, times: 1 });
    await sim.injectPost(MASTER_TG, 'rate limited');
    await engine.tick();

    const row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('scheduled');
    expect(row.lastError).toContain('FLOOD_WAIT');

    nowMs += 31_000;
    await drain();
    expect(sim.sent).toHaveLength(1);
    expect([...store.forwards.values()][0]!.state).toBe('done');
  });

  it('retries transient network errors with backoff, then fails', async () => {
    sim.failures.set(RECEIVER1_TG, { code: 'network' });
    await sim.injectPost(MASTER_TG, 'flaky network');
    await drain(120); // backoffs total 156s of simulated time

    const row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('failed');
    expect(row.attempts).toBeGreaterThanOrEqual(5);
    expect(sim.sent).toHaveLength(0);
  });

  it('auto-pauses a route after repeated permission failures and opens incidents', async () => {
    sim.failures.set(RECEIVER1_TG, { code: 'forbidden' });
    await sim.injectPost(MASTER_TG, 'one');
    await sim.injectPost(MASTER_TG, 'two');
    await sim.injectPost(MASTER_TG, 'three');
    await drain();

    expect(store.config.routes[0]!.enabled).toBe(false);
    expect(store.incidents.some((i) => i.kind === 'receiver_no_permission')).toBe(true);
    expect(store.incidents.some((i) => i.kind === 'route_autopaused')).toBe(true);
    expect(store.config.channels.find((c) => c.id === 'r1')!.health).toBe('no_permission');
  });

  it('marks protected masters and drops their messages', async () => {
    sim.failures.set(RECEIVER1_TG, { code: 'protected' });
    await sim.injectPost(MASTER_TG, 'cannot copy this');
    await drain();

    expect([...store.forwards.values()][0]!.state).toBe('dropped');
    expect(store.config.channels.find((c) => c.id === 'm1')!.health).toBe('protected');
    expect(store.incidents.some((i) => i.kind === 'protected_content')).toBe(true);
  });
});

describe('RelayEngine — edit & delete sync', () => {
  it('replays edits onto the receiver copy with rules applied', async () => {
    store.config.routes = [
      baseRoute({ rules: parseRouteRules({ replacements: [{ find: 'TP', replace: 'Target' }] }) }),
    ];
    await engine.reload();

    const msg = await sim.injectPost(MASTER_TG, 'TP 2680');
    await drain();
    const destId = sim.sent[0]!.destMessageIds[0]!;

    await sim.injectEdit(MASTER_TG, msg.messageId, 'TP 2700 updated');
    await drain();

    expect(sim.edits).toHaveLength(1);
    expect(sim.edits[0]).toMatchObject({ chatId: RECEIVER1_TG, messageId: destId });
    expect(sim.edits[0]!.text.text).toBe('Target 2700 updated');
  });

  it('does not sync edits when the route disables it', async () => {
    store.config.routes = [baseRoute({ syncEdits: false })];
    await engine.reload();

    const msg = await sim.injectPost(MASTER_TG, 'original');
    await drain();
    await sim.injectEdit(MASTER_TG, msg.messageId, 'changed');
    await drain();

    expect(sim.edits).toHaveLength(0);
  });

  it('deletes receiver copies when the master deletes', async () => {
    const msg = await sim.injectPost(MASTER_TG, 'to be deleted');
    await drain();
    const destId = sim.sent[0]!.destMessageIds[0]!;

    await sim.injectDelete(MASTER_TG, [msg.messageId]);
    await drain();

    expect(sim.deletions).toHaveLength(1);
    expect(sim.deletions[0]).toEqual({ chatId: RECEIVER1_TG, messageIds: [destId] });
  });
});

describe('RelayEngine — catch-up', () => {
  it('replays missed history after downtime without duplicating', async () => {
    const missed = {
      chatId: MASTER_TG,
      messageId: 900,
      date: Math.floor(nowMs / 1000) - 120,
      media: 'text' as const,
      text: { text: 'missed while offline', entities: [] },
    };
    sim.historyByChat.set(MASTER_TG, [missed]);

    await engine.catchUp();
    await engine.catchUp(); // second run must not duplicate
    await drain();

    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.text.text).toBe('missed while offline');
  });
});

describe('RelayEngine — delivery is never duplicated by storage failures', () => {
  it('retries the completion write instead of re-sending the post', async () => {
    const original = store.updateForward.bind(store);
    let failedOnce = false;
    store.updateForward = async (id, patch) => {
      if (patch.state === 'done' && !failedOnce) {
        failedOnce = true;
        throw new Error('sim: transient storage outage');
      }
      return original(id, patch);
    };

    await sim.injectPost(MASTER_TG, 'exactly once');
    await drain();

    expect(failedOnce).toBe(true);
    expect(sim.sent).toHaveLength(1); // the send never repeated
    const row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('done');
  });

  it('parks an unconfirmed forward as failed instead of requeueing it', async () => {
    await setup(); // fresh engine with default options
    engine = new RelayEngine(store, { albumWaitMs: 15, clock, staleSendingSeconds: 5 });
    engine.registerTransport(sim);
    await engine.init();
    await sim.start(engine.handlers);

    const original = store.updateForward.bind(store);
    store.updateForward = async (id, patch) => {
      if (patch.state === 'done') throw new Error('sim: storage down for good');
      return original(id, patch);
    };

    await sim.injectPost(MASTER_TG, 'sent but unconfirmed');
    await engine.tick(); // send succeeds, completion write keeps failing

    expect(sim.sent).toHaveLength(1);
    let row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('sending');

    store.updateForward = original; // storage recovers
    nowMs += 120_000; // past staleSendingSeconds AND the reaper's 60s interval
    await engine.tick();

    row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('failed'); // parked — NOT requeued, NOT re-sent
    expect(row.lastError).toContain('unconfirmed');
    expect(sim.sent).toHaveLength(1);
  });
});

/** Sends album items one by one (Bot API style) and can fail mid-loop. */
class ItemwiseSim extends SimTransport {
  failAfterItems = Infinity;
  private destSeq = 5000;

  override async copy(opts: SendOptions): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < opts.srcMessageIds.length; i += 1) {
      if (i >= this.failAfterItems) {
        throw new TransportError('network', 'sim: album interrupted mid-loop');
      }
      ids.push(this.destSeq++);
      await opts.onSent?.(ids.slice());
    }
    this.sent.push({ ...opts, destMessageIds: ids.slice(), native: false });
    return ids;
  }
}

describe('RelayEngine — album resume', () => {
  it('a retried album skips items that already went out', async () => {
    const itemwise = new ItemwiseSim('acc-sim');
    engine = new RelayEngine(store, { albumWaitMs: 15, clock, backoffSeconds: [1] });
    engine.registerTransport(itemwise);
    await engine.init();
    await itemwise.start(engine.handlers);

    itemwise.failAfterItems = 2;
    for (const id of [21, 22, 23, 24]) {
      await itemwise.injectPost(MASTER_TG, id === 21 ? 'album caption' : '', {
        media: 'photo',
        albumKey: 'albX',
        messageId: id,
      });
    }
    await sleep(40); // let the album window close
    await engine.tick(); // first attempt: 2 items land, then the loop dies

    let row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('queued'); // requeued with backoff
    expect(row.destMessageIds).toHaveLength(2); // checkpointed progress

    itemwise.failAfterItems = Infinity;
    await drain();

    row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('done');
    expect(row.destMessageIds).toHaveLength(4);
    expect(new Set(row.destMessageIds).size).toBe(4); // no item delivered twice

    // the resumed batch carried only the remaining 2 items, without a caption
    const resumed = itemwise.sent.at(-1)!;
    expect(resumed.srcMessageIds).toEqual([23, 24]);
    expect(resumed.applyCaption).toBe(false);
  });
});

describe('RelayEngine — edits and deletes against a not-yet-sent post', () => {
  it('an edit while the post is still queued rewrites it in place — one send, edited text', async () => {
    store.config.routes = [baseRoute({ delaySeconds: 60 })];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'buy gold at 2650', { messageId: 70 });
    await sleep(30); // past album window; post is now scheduled 60s out
    await engine.tick();
    expect(sim.sent).toHaveLength(0);

    await sim.injectEdit(MASTER_TG, 70, 'buy gold at 2700 CORRECTED');
    nowMs += 61_000;
    await drain();

    expect(sim.sent).toHaveLength(1); // never a second message
    expect(sim.sent[0]!.text.text).toBe('buy gold at 2700 CORRECTED');
    expect(sim.edits).toHaveLength(0); // no edit call — nothing was out yet
  });

  it('a delete while the post is still queued cancels it — nothing is ever sent', async () => {
    store.config.routes = [baseRoute({ delaySeconds: 60 })];
    await engine.reload();

    await sim.injectPost(MASTER_TG, 'deleted before send', { messageId: 71 });
    await sleep(30);
    await engine.tick();

    await sim.injectDelete(MASTER_TG, [71]);
    nowMs += 61_000;
    await drain();

    expect(sim.sent).toHaveLength(0);
    expect(sim.deletions).toHaveLength(0);
    const row = [...store.forwards.values()].find((f) => f.srcMessageId === 71)!;
    expect(row.state).toBe('dropped');
    expect(row.dropReason).toContain('deleted at the source');
  });
});

describe('RelayEngine — immediate delivery (hot path)', () => {
  const immediateEngine = async (patch?: (cfg: RelayConfig) => void, transport?: Transport) => {
    patch?.(store.config);
    engine = new RelayEngine(store, { albumWaitMs: 15, clock, immediateDelivery: true });
    const t = transport ?? sim;
    engine.registerTransport(t);
    await engine.init();
    await t.start(engine.handlers);
  };

  it('delivers a post during ingest — no sender-loop tick needed', async () => {
    await immediateEngine();
    await sim.injectPost(MASTER_TG, 'instant');

    expect(sim.sent).toHaveLength(1); // no engine.tick() was called
    const row = [...store.forwards.values()][0]!;
    expect(row.state).toBe('done');
  });

  it('keeps posts from one master in order, even when they arrive together', async () => {
    await immediateEngine();
    await Promise.all(
      ['1 BUY', '2 SL moved', '3 TP hit'].map((text, i) =>
        sim.injectPost(MASTER_TG, text, { messageId: 500 + i }),
      ),
    );

    expect(sim.sent.map((s) => s.text.text)).toEqual(['1 BUY', '2 SL moved', '3 TP hit']);
  });

  it('fans one post out to every receiver in parallel', async () => {
    await immediateEngine((cfg) => cfg.routes.push(baseRoute({ id: 'rt2', receiverId: 'r2' })));
    await sim.injectPost(MASTER_TG, 'fan out');
    expect(sim.sent.map((s) => s.toChatId).sort()).toEqual([RECEIVER1_TG, RECEIVER2_TG]);
  });

  it('an edit arriving right behind its post still finds it', async () => {
    await immediateEngine();
    const posted = sim.injectPost(MASTER_TG, 'entry 1.0850', { messageId: 610 });
    const edited = sim.injectEdit(MASTER_TG, 610, 'entry 1.0900');
    await Promise.all([posted, edited]);

    expect(sim.sent).toHaveLength(1);
    expect(sim.edits.map((e) => e.text.text)).toEqual(['entry 1.0900']);
  });

  it('never relays its own delivery back out (A → B → A loops)', async () => {
    await immediateEngine((cfg) => {
      // the receiver chat is ALSO a master, routed onward to a second receiver
      cfg.channels.push({
        id: 'm2', role: 'master', tgChatId: RECEIVER1_TG, title: 'VIP as master',
        enabled: true, health: 'ok', isProtected: false,
      });
      cfg.memberships.push({
        accountId: 'acc-sim', channelId: 'm2', isMember: true, isAdmin: true,
        canPost: true, canEdit: true, canDelete: true,
      });
      cfg.routes.push(baseRoute({ id: 'rt-loop', masterId: 'm2', receiverId: 'r2' }));
    });

    await sim.injectPost(MASTER_TG, 'original');
    const ourCopy = sim.sent[0]!;
    // the reader now sees our copy appear in the receiver chat
    await sim.injectPost(RECEIVER1_TG, 'original', { messageId: ourCopy.destMessageIds[0] });
    expect(sim.sent).toHaveLength(1);

    // a genuinely new post in that chat still relays
    await sim.injectPost(RECEIVER1_TG, 'written by a human', { messageId: 99_999 });
    expect(sim.sent.map((s) => s.toChatId)).toEqual([RECEIVER1_TG, RECEIVER2_TG]);
  });

  it('bursts are allowed; only a full window is held back, then drains in order', async () => {
    // pacing applies to real accounts — present the simulator as a bot
    const botLike = new Proxy(sim, {
      get: (target, prop, receiver) => (prop === 'kind' ? 'bot' : Reflect.get(target, prop, receiver)),
    }) as unknown as Transport;
    await immediateEngine((cfg) => {
      cfg.accounts[0]!.kind = 'bot';
      cfg.accounts[0]!.maxMsgsPerMinute = 3; // receiver window: 3 per minute
    }, botLike);

    for (let i = 0; i < 5; i += 1) {
      await sim.injectPost(MASTER_TG, `burst ${i}`, { messageId: 700 + i });
    }
    expect(sim.sent.map((s) => s.text.text)).toEqual(['burst 0', 'burst 1', 'burst 2']);
    const held = [...store.forwards.values()].filter((f) => f.state === 'queued');
    expect(held).toHaveLength(2);

    nowMs += 61_000;
    await drain();
    expect(sim.sent.map((s) => s.text.text)).toEqual(['burst 0', 'burst 1', 'burst 2', 'burst 3', 'burst 4']);
  });

  it('holds an album open while items keep arriving, then sends it once', async () => {
    engine = new RelayEngine(store, { albumWaitMs: 60, clock, immediateDelivery: true });
    engine.registerTransport(sim);
    await engine.init();
    await sim.start(engine.handlers);

    for (const id of [801, 802, 803]) {
      await sim.injectPost(MASTER_TG, id === 801 ? 'caption' : '', {
        media: 'photo', albumKey: 'alb-slow', messageId: id,
      });
      await sleep(25); // each gap is shorter than the quiet window
    }
    await sleep(150);

    expect(sim.sent).toHaveLength(1);
    expect(sim.sent[0]!.srcMessageIds).toEqual([801, 802, 803]);
  });
});

describe('RelayEngine — chat discovery', () => {
  it('records chats reported by a reader', async () => {
    await engine.handlers.onChatSeen?.(
      'acc-sim',
      {
        tgChatId: '-1009876543210', chatType: 'supergroup', title: 'Private group',
        status: 'administrator', canRead: true, canPost: true,
      },
      true,
    );
    expect(store.discovered.get('acc-sim:-1009876543210')?.title).toBe('Private group');
  });

  it('follows a basic group upgrading to a supergroup', async () => {
    await engine.handlers.onChatMigrated?.(MASTER_TG, '-1005550001111');
    await sim.injectPost('-1005550001111', 'after upgrade');
    await drain();
    expect(sim.sent).toHaveLength(1);
  });
});
