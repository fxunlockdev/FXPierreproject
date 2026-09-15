import type { AlertSettings } from './model';

export interface AlertDeps {
  getSettings(): Promise<AlertSettings>;
  /** Send a Telegram message via the alert bot; target is @username or chat id. */
  sendTelegram(target: string, text: string): Promise<void>;
}

/**
 * Fans one incident notification out to Telegram / webhook / email with
 * per-trigger switches and a cooldown so a flapping channel can't spam.
 */
export class AlertDispatcher {
  private lastSent = new Map<string, number>();
  private cachedSettings: { value: AlertSettings; at: number } | null = null;

  constructor(private deps: AlertDeps) {}

  private async settings(): Promise<AlertSettings> {
    const now = Date.now();
    if (this.cachedSettings && now - this.cachedSettings.at < 30_000) {
      return this.cachedSettings.value;
    }
    const value = await this.deps.getSettings();
    this.cachedSettings = { value, at: now };
    return value;
  }

  async dispatch(kind: string, title: string, body: string): Promise<void> {
    let s: AlertSettings;
    try {
      s = await this.settings();
    } catch {
      return; // no settings — nothing to send
    }

    if (s.triggers[kind] === false) return;

    const cooldownMs = s.cooldownMinutes * 60_000;
    const key = `${kind}:${title}`;
    const last = this.lastSent.get(key) ?? 0;
    if (cooldownMs > 0 && Date.now() - last < cooldownMs) return;
    this.lastSent.set(key, Date.now());

    const text = `⚠️ ${title}\n${body}`;

    if (s.telegramEnabled && s.telegramTarget) {
      try {
        await this.deps.sendTelegram(s.telegramTarget, text);
      } catch (err) {
        console.error('[alerts] telegram delivery failed:', err);
      }
    }

    if (s.webhookEnabled && s.webhookUrl) {
      try {
        await fetch(s.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, title, body, text, source: 'pierre-relay' }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        console.error('[alerts] webhook delivery failed:', err);
      }
    }

    if (s.emailEnabled && s.emailTo) {
      const apiKey = process.env['RESEND_API_KEY'];
      if (!apiKey) {
        console.warn('[alerts] email enabled but RESEND_API_KEY is not set — skipping');
        return;
      }
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            from: process.env['ALERT_EMAIL_FROM'] ?? 'relay@resend.dev',
            to: [s.emailTo],
            subject: `[Relay] ${title}`,
            text: `${body}\n\n— Pierre Relay`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        console.error('[alerts] email delivery failed:', err);
      }
    }
  }
}
