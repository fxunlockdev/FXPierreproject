import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Bot } from 'grammy';
import type { AlertDispatcher } from './alerts';
import { encryptSecret } from './crypto';
import type { Env } from './env';
import type { RelayEngine } from './engine';
import type { Store } from './store/store';
import { BotApiTransport } from './transport/botapi';
import { GramJsTransport } from './transport/gramjs';
import type { SimTransport } from './transport/sim';
import { TransportError, type Transport } from './transport/transport';

export interface AdminOps {
  insertAccount(fields: {
    kind: 'user' | 'bot';
    label: string;
    phone?: string;
    username?: string;
    tgId?: string;
    status: string;
    isAlertSender?: boolean;
  }): Promise<string>;
  upsertChannelMeta(
    channelId: string,
    meta: { tgChatId: string; title: string; username?: string; isProtected: boolean },
  ): Promise<void>;
  upsertMembership(m: {
    accountId: string;
    channelId: string;
    isMember: boolean;
    isAdmin: boolean;
    canPost: boolean;
    canEdit: boolean;
    canDelete: boolean;
  }): Promise<void>;
}

export interface ServerDeps {
  env: Env;
  engine: RelayEngine;
  store: Store;
  admin: AdminOps | null;
  dispatcher: AlertDispatcher;
  sim: SimTransport | null;
  registerTransport(t: Transport): Promise<void>;
}

interface PendingLogin {
  id: string;
  phone: string;
  label: string;
  phase: 'starting' | 'code' | 'password' | 'done' | 'error';
  error?: string;
  accountId?: string;
  client: TelegramClient;
  codeResolve?: (code: string) => void;
  passwordResolve?: (pw: string) => void;
  createdAt: number;
}

/** Abandoned phone-login sessions are swept after this long. */
const LOGIN_TTL_MS = 15 * 60_000;

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { env, engine, store, admin, dispatcher, sim } = deps;
  const app = Fastify({ logger: false });
  const logins = new Map<string, PendingLogin>();

  app.addHook('onRequest', (req, reply, done) => {
    if (req.url === '/health') return done();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, env.WORKER_API_TOKEN)) {
      void reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    done();
  });

  app.get('/health', async () => ({
    ok: true,
    simulate: env.SIMULATE,
    accounts: engine.config.accounts.length,
  }));

  // ── user-account login (phone → code → optional 2FA password) ─────────────

  app.post('/login/start', async (req, reply) => {
    const body = z.object({ phone: z.string().min(5), label: z.string().min(1).max(80) }).parse(req.body);
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      return reply.code(400).send({ error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not configured on the worker' });
    }
    if (!admin) return reply.code(400).send({ error: 'admin operations unavailable' });

    const id = randomUUID();
    const client = new TelegramClient(new StringSession(''), env.TELEGRAM_API_ID, env.TELEGRAM_API_HASH, {
      connectionRetries: 3,
    });
    // sweep abandoned logins so the map (and their sockets) can't leak
    for (const [key, stale] of logins) {
      if (Date.now() - stale.createdAt > LOGIN_TTL_MS) {
        void stale.client.destroy().catch(() => {});
        logins.delete(key);
      }
    }

    const pending: PendingLogin = {
      id,
      phone: body.phone,
      label: body.label,
      phase: 'starting',
      client,
      createdAt: Date.now(),
    };
    logins.set(id, pending);

    void client
      .start({
        phoneNumber: async () => body.phone,
        phoneCode: () =>
          new Promise<string>((resolve) => {
            pending.phase = 'code';
            pending.codeResolve = resolve;
          }),
        password: () =>
          new Promise<string>((resolve) => {
            pending.phase = 'password';
            pending.passwordResolve = resolve;
          }),
        onError: async (err) => {
          pending.phase = 'error';
          pending.error = String(err.message ?? err);
          return true; // stop retrying
        },
      })
      .then(async () => {
        const me = await client.getMe();
        const session = (client.session as StringSession).save();
        const accountId = await admin.insertAccount({
          kind: 'user',
          label: body.label,
          phone: body.phone,
          username: me.username ?? undefined,
          tgId: me.id.toString(),
          status: 'connected',
        });
        await store.setSecret(accountId, encryptSecret(session, env.SESSION_ENCRYPTION_KEY));
        await client.disconnect();
        await deps.registerTransport(
          new GramJsTransport(accountId, env.TELEGRAM_API_ID!, env.TELEGRAM_API_HASH!, session),
        );
        await engine.reload();
        pending.accountId = accountId;
        pending.phase = 'done';
      })
      .catch((err: unknown) => {
        pending.phase = 'error';
        pending.error = err instanceof Error ? err.message : String(err);
      });

    return { loginId: id };
  });

  app.get('/login/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const pending = logins.get(id);
    if (!pending) return reply.code(404).send({ error: 'unknown login' });
    return { phase: pending.phase, error: pending.error, accountId: pending.accountId };
  });

  app.post('/login/:id/code', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { code } = z.object({ code: z.string().min(3).max(10) }).parse(req.body);
    const pending = logins.get(id);
    if (!pending?.codeResolve) return reply.code(409).send({ error: 'not waiting for a code' });
    pending.phase = 'starting';
    pending.codeResolve(code);
    pending.codeResolve = undefined;
    return { ok: true };
  });

  app.post('/login/:id/password', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
    const pending = logins.get(id);
    if (!pending?.passwordResolve) return reply.code(409).send({ error: 'not waiting for a password' });
    pending.phase = 'starting';
    pending.passwordResolve(password);
    pending.passwordResolve = undefined;
    return { ok: true };
  });

  // ── bot accounts ──────────────────────────────────────────────────────────

  app.post('/accounts/bot', async (req, reply) => {
    const body = z
      .object({
        token: z.string().regex(/^\d+:[\w-]{30,}$/, 'that does not look like a bot token'),
        label: z.string().min(1).max(80),
        isAlertSender: z.boolean().default(false),
      })
      .parse(req.body);
    if (!admin) return reply.code(400).send({ error: 'admin operations unavailable' });

    const probe = new Bot(body.token);
    try {
      await probe.init();
    } catch {
      return reply.code(400).send({ error: 'Telegram rejected this bot token' });
    }
    // Two connections polling one bot steal each other's updates.
    const botId = String(probe.botInfo.id);
    if (engine.config.accounts.some((a) => a.kind === 'bot' && a.tgId === botId)) {
      return reply
        .code(409)
        .send({ error: `@${probe.botInfo.username} is already connected — add a different bot to share the load` });
    }

    const accountId = await admin.insertAccount({
      kind: 'bot',
      label: body.label,
      username: probe.botInfo.username,
      tgId: String(probe.botInfo.id),
      status: 'connected',
      isAlertSender: body.isAlertSender,
    });
    await store.setSecret(accountId, encryptSecret(body.token, env.SESSION_ENCRYPTION_KEY));
    await deps.registerTransport(new BotApiTransport(accountId, body.token));
    await engine.reload();
    return { accountId, username: probe.botInfo.username };
  });

  // ── channels ──────────────────────────────────────────────────────────────

  const pickResolver = (preferAccountId?: string): Transport | undefined => {
    if (preferAccountId) {
      const t = engine.transport(preferAccountId);
      if (t) return t;
    }
    const accounts = engine.config.accounts;
    const user = accounts.find((a) => a.kind === 'user' && a.status === 'connected');
    if (user) {
      const t = engine.transport(user.id);
      if (t) return t;
    }
    const bot = accounts.find((a) => a.kind === 'bot' && a.status === 'connected');
    if (bot) {
      const t = engine.transport(bot.id);
      if (t) return t;
    }
    return sim ?? undefined;
  };

  app.post('/channels/resolve', async (req, reply) => {
    const body = z
      .object({ channelId: z.string().uuid(), ref: z.string().min(2), accountId: z.string().uuid().optional() })
      .parse(req.body);
    if (!admin) return reply.code(400).send({ error: 'admin operations unavailable' });

    const resolver = pickResolver(body.accountId);
    if (!resolver) return reply.code(409).send({ error: 'no connected Telegram account can resolve channels yet' });

    try {
      const meta = await resolver.resolveChannel(body.ref);
      await admin.upsertChannelMeta(body.channelId, meta);
      if (resolver.kind !== 'sim') {
        await admin.upsertMembership({
          accountId: resolver.accountId,
          channelId: body.channelId,
          isMember: true,
          isAdmin: false,
          canPost: false,
          canEdit: false,
          canDelete: false,
        });
      }
      await engine.reload();
      return meta;
    } catch (err) {
      const e = err instanceof TransportError ? err : new TransportError('unknown', String(err));
      return reply.code(422).send({ error: e.message, code: e.code });
    }
  });

  app.post('/channels/join', async (req, reply) => {
    const body = z
      .object({ channelId: z.string().uuid(), ref: z.string().min(2), accountId: z.string().uuid().optional() })
      .parse(req.body);
    if (!admin) return reply.code(400).send({ error: 'admin operations unavailable' });

    const joiner = pickResolver(body.accountId);
    if (!joiner) return reply.code(409).send({ error: 'no connected account available' });

    try {
      const meta = await joiner.joinChannel(body.ref);
      await admin.upsertChannelMeta(body.channelId, meta);
      if (joiner.kind !== 'sim') {
        await admin.upsertMembership({
          accountId: joiner.accountId,
          channelId: body.channelId,
          isMember: true,
          isAdmin: false,
          canPost: false,
          canEdit: false,
          canDelete: false,
        });
      }
      await engine.reload();
      return meta;
    } catch (err) {
      const e = err instanceof TransportError ? err : new TransportError('unknown', String(err));
      return reply.code(422).send({ error: e.message, code: e.code });
    }
  });

  // ── queue actions & alerts ────────────────────────────────────────────────

  app.post('/forwards/retry', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.body);
    await store.updateForward(id, { state: 'queued', deliverAt: new Date(), attempts: 0 });
    return { ok: true };
  });

  app.post('/alerts/test', async () => {
    await store.notify('test', 'Test alert', 'If you can read this, alert delivery works.');
    await dispatcher.dispatch('test', 'Test alert', 'If you can read this, alert delivery works.');
    return { ok: true };
  });

  // ── simulator hooks (only exist in SIMULATE mode; used by e2e tests) ──────

  if (env.SIMULATE && sim) {
    const firstMaster = () =>
      engine.config.channels.find(
        (c) => c.role === 'master' && c.enabled && c.tgChatId && !c.isProtected,
      );

    app.post('/sim/post', async (req, reply) => {
      const body = z
        .object({
          text: z.string().max(4096),
          chatTgId: z.string().optional(),
          media: z.enum(['text', 'photo', 'video', 'document']).default('text'),
        })
        .parse(req.body);
      // an explicit injection must see channels/routes saved a moment ago,
      // even if the realtime config push hasn't landed yet
      await engine.reload();
      const chatId = body.chatTgId ?? firstMaster()?.tgChatId;
      if (!chatId) return reply.code(409).send({ error: 'no enabled master channel to post into' });
      const msg = await sim.injectPost(chatId, body.text, { media: body.media });
      return { messageId: msg.messageId, chatTgId: chatId };
    });

    app.post('/sim/edit', async (req) => {
      const body = z
        .object({ chatTgId: z.string(), messageId: z.number().int(), text: z.string().max(4096) })
        .parse(req.body);
      await engine.reload();
      await sim.injectEdit(body.chatTgId, body.messageId, body.text);
      return { ok: true };
    });

    app.post('/sim/delete', async (req) => {
      const body = z
        .object({ chatTgId: z.string(), messageIds: z.array(z.number().int()).min(1) })
        .parse(req.body);
      await engine.reload();
      await sim.injectDelete(body.chatTgId, body.messageIds);
      return { ok: true };
    });

    // Configure a delivery failure for a target chat (e2e error-path testing).
    app.post('/sim/fail', async (req) => {
      const body = z
        .object({
          chatTgId: z.string(),
          code: z.enum(['flood_wait', 'forbidden', 'protected', 'not_found', 'network', 'off']),
          retryAfterSeconds: z.number().int().min(0).max(3600).optional(),
          times: z.number().int().min(1).max(100).optional(),
        })
        .parse(req.body);
      if (body.code === 'off') {
        sim.failures.delete(body.chatTgId);
      } else {
        sim.failures.set(body.chatTgId, {
          code: body.code,
          retryAfterSeconds: body.retryAfterSeconds,
          times: body.times,
        });
      }
      return { ok: true };
    });
  }

  return app;
}
