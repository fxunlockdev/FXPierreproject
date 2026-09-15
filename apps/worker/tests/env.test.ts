import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';

const base = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40),
  SESSION_ENCRYPTION_KEY: 'k'.repeat(32),
  WORKER_API_TOKEN: 't'.repeat(24),
};

describe('loadEnv', () => {
  it('accepts SIMULATE=1 without Telegram credentials', () => {
    const env = loadEnv({ ...base, SIMULATE: '1' });
    expect(env.SIMULATE).toBe(true);
    expect(env.PORT).toBe(8787);
    expect(env.CONFIG_POLL_SECONDS).toBe(30);
  });

  it('requires Telegram api credentials outside simulate mode', () => {
    expect(() => loadEnv({ ...base, SIMULATE: '0' })).toThrow(/TELEGRAM_API_ID/);
  });

  it('rejects a short encryption key with a readable message', () => {
    expect(() => loadEnv({ ...base, SIMULATE: '1', SESSION_ENCRYPTION_KEY: 'short' })).toThrow(
      /at least 32/,
    );
  });

  it('coerces numeric settings', () => {
    const env = loadEnv({ ...base, SIMULATE: 'true', PORT: '9000', CONFIG_POLL_SECONDS: '2' });
    expect(env.PORT).toBe(9000);
    expect(env.CONFIG_POLL_SECONDS).toBe(2);
  });
});
