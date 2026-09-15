import { describe, expect, it, vi } from 'vitest';
import { AlertDispatcher, assertPublicWebhookUrl } from '../src/alerts';
import type { AlertSettings } from '../src/model';

const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  telegramEnabled: true,
  telegramTarget: '@alerts',
  emailEnabled: false,
  emailTo: null,
  webhookEnabled: false,
  webhookUrl: null,
  cooldownMinutes: 15,
  triggers: {},
  ...over,
});

describe('assertPublicWebhookUrl — SSRF guard', () => {
  it.each([
    'http://example.com/hook', // https only
    'https://127.0.0.1/hook',
    'https://10.0.0.8/hook',
    'https://172.16.4.4/hook',
    'https://192.168.1.10/hook',
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://100.64.0.1/hook', // CGNAT
    'https://[::1]/hook',
    'https://[fe80::1]/hook',
    'https://[fd00::1]/hook',
    'not a url',
  ])('rejects %s', async (url) => {
    await expect(assertPublicWebhookUrl(url)).rejects.toThrow();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(assertPublicWebhookUrl('https://localhost/hook')).rejects.toThrow(/private/);
  });
});

describe('AlertDispatcher', () => {
  const make = (s: AlertSettings) => {
    const sendTelegram = vi.fn(async () => {});
    const dispatcher = new AlertDispatcher({ getSettings: async () => s, sendTelegram });
    return { dispatcher, sendTelegram };
  };

  it('sends telegram alerts to the configured target', async () => {
    const { dispatcher, sendTelegram } = make(settings());
    await dispatcher.dispatch('worker_offline', 'Relay offline', 'no heartbeat');
    expect(sendTelegram).toHaveBeenCalledWith('@alerts', expect.stringContaining('Relay offline'));
  });

  it('respects per-trigger switches', async () => {
    const { dispatcher, sendTelegram } = make(settings({ triggers: { flood_wait: false } }));
    await dispatcher.dispatch('flood_wait', 'Rate limited', 'waiting 90s');
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it('applies the cooldown to repeats of the same alert', async () => {
    const { dispatcher, sendTelegram } = make(settings());
    await dispatcher.dispatch('worker_offline', 'Relay offline', 'first');
    await dispatcher.dispatch('worker_offline', 'Relay offline', 'second');
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('keeps going when the telegram delivery fails', async () => {
    const sendTelegram = vi.fn(async () => {
      throw new Error('bot down');
    });
    const dispatcher = new AlertDispatcher({ getSettings: async () => settings(), sendTelegram });
    await expect(dispatcher.dispatch('worker_offline', 'Relay offline', 'x')).resolves.toBeUndefined();
  });

  it('never fetches a private webhook url', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { dispatcher } = make(
      settings({
        telegramEnabled: false,
        webhookEnabled: true,
        webhookUrl: 'https://169.254.169.254/latest/meta-data',
      }),
    );
    await dispatcher.dispatch('worker_offline', 'Relay offline', 'x');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
