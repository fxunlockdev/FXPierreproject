import { hostname } from 'node:os';
import { AlertDispatcher } from './alerts';
import { decryptSecret } from './crypto';
import { RelayEngine } from './engine';
import { loadEnv } from './env';
import { buildServer } from './server';
import { SupabaseStore } from './store/supabase-store';
import { BotApiTransport } from './transport/botapi';
import { GramJsTransport } from './transport/gramjs';
import { SimTransport } from './transport/sim';
import type { Transport } from './transport/transport';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const env = loadEnv();

  // Wiring order matters: the store's alert sink calls the dispatcher, and the
  // dispatcher sends through whichever transport the engine currently holds.
  let dispatcher: AlertDispatcher | null = null;
  const store = new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, (k, t, b) => {
    void dispatcher?.dispatch(k, t, b);
  });
  const engine = new RelayEngine(store);

  dispatcher = new AlertDispatcher({
    getSettings: () => store.getAlertSettings(),
    sendTelegram: async (target, text) => {
      if (env.SIMULATE) {
        console.log(`[sim alert → ${target}] ${text}`);
        return;
      }
      const ordered = [...engine.config.accounts].sort(
        (a, b) =>
          Number(b.isAlertSender) - Number(a.isAlertSender) ||
          (a.kind === 'bot' ? -1 : 1) - (b.kind === 'bot' ? -1 : 1),
      );
      for (const acc of ordered) {
        const t = engine.transport(acc.id) as
          | { sendPlain?: (target: string, text: string) => Promise<void> }
          | undefined;
        if (t?.sendPlain) {
          await t.sendPlain(target, text);
          return;
        }
      }
      throw new Error('no connected Telegram account is available to deliver alerts');
    },
  });

  await engine.init();

  const registerTransport = async (t: Transport): Promise<void> => {
    engine.registerTransport(t);
    await t.start(engine.handlers);
  };

  let sim: SimTransport | null = null;
  if (env.SIMULATE) {
    sim = new SimTransport('sim');
    await registerTransport(sim);
    console.log('[worker] SIMULATE=1 — running against the built-in Telegram simulator');
  } else {
    for (const acc of engine.config.accounts) {
      if (acc.status === 'disabled') continue;
      const encrypted = await store.getSecret(acc.id);
      if (!encrypted) continue;
      try {
        const secret = decryptSecret(encrypted, env.SESSION_ENCRYPTION_KEY);
        const transport =
          acc.kind === 'user'
            ? new GramJsTransport(acc.id, env.TELEGRAM_API_ID!, env.TELEGRAM_API_HASH!, secret)
            : new BotApiTransport(acc.id, secret);
        await registerTransport(transport);
        await store.setAccountStatus(acc.id, 'connected');
        console.log(`[worker] connected ${acc.kind} account "${acc.label}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker] failed to connect "${acc.label}": ${message}`);
        await store.setAccountStatus(acc.id, 'relogin_required', message);
        const { isNew, id } = await store.openIncident(
          'session_revoked',
          { accountId: acc.id },
          `Could not connect ${acc.label}: ${message}`,
        );
        if (isNew) {
          await store.notify('session_revoked', 'Account needs re-login', `${acc.label} could not connect. Reconnect it from the Accounts page.`, id);
        }
      }
    }
  }

  await engine.reload();
  await engine.catchUp();

  // heartbeat + sender loop + config poll (realtime handles most reloads)
  const instanceId = `worker-${hostname()}-${process.pid}`;
  const startedAt = new Date();
  const beat = async (): Promise<void> => {
    try {
      await store.heartbeat({
        instanceId,
        startedAt,
        version: VERSION,
        accountsOnline: engine.config.accounts.filter((a) => engine.transport(a.id)).length,
        queueDepth: await store.countPending(),
        simulate: env.SIMULATE,
      });
    } catch (err) {
      console.error('[worker] heartbeat failed:', err);
    }
  };
  await beat();
  const heartbeatTimer = setInterval(() => void beat(), 30_000);

  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    engine
      .tick()
      .catch((err) => console.error('[worker] tick failed:', err))
      .finally(() => {
        ticking = false;
      });
  }, 800);

  const pollTimer = setInterval(
    () => void engine.reload().catch(() => {}),
    env.CONFIG_POLL_SECONDS * 1000,
  );

  const app = buildServer({
    env,
    engine,
    store,
    admin: store,
    dispatcher,
    sim,
    registerTransport,
  });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[worker] admin API listening on :${env.PORT}`);

  const shutdown = async (): Promise<void> => {
    console.log('[worker] shutting down…');
    clearInterval(heartbeatTimer);
    clearInterval(tickTimer);
    clearInterval(pollTimer);
    await app.close();
    await engine.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
