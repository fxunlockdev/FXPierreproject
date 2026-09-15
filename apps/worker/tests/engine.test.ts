import { beforeEach, describe, expect, it } from 'vitest';
import { parseRouteRules, parseRouteSchedule } from '@pierre/core';
import { RelayEngine } from '../src/engine.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { SimTransport } from '../src/transport/sim.js';
import type { RelayConfig, Route } from '../src/model.js';

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
