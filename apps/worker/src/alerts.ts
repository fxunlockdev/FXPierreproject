import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AlertSettings } from './model';

/** RFC1918 / loopback / link-local / metadata / ULA ranges the webhook may never hit. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7)); // v4-mapped
    return (
      v6 === '::1' ||
      v6 === '::' ||
      v6.startsWith('fe80:') || // link-local
      v6.startsWith('fc') || // unique-local
      v6.startsWith('fd')
    );
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // unparseable → refuse
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local + cloud metadata (169.254.169.254)
    (a === 100 && b >= 64 && b <= 127) // CGNAT
  );
}

/**
 * SSRF guard for the admin-configurable webhook: https only, and the
 * resolved address must be public. Throws with a readable reason.
 */
export async function assertPublicWebhookUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('webhook URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('webhook URL must use https');
  const host = url.hostname;
  if (isIP(host) ? isPrivateAddress(host) : false) {
    throw new Error('webhook URL must not point at a private address');
  }
  if (!isIP(host)) {
    const resolved = await lookup(host, { all: true });
    if (resolved.length === 0 || resolved.some((r) => isPrivateAddress(r.address))) {
      throw new Error('webhook host resolves to a private address');
    }
  }
}

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
        await assertPublicWebhookUrl(s.webhookUrl);
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
