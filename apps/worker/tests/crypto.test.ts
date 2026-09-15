import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto';

const KEY = 'a-test-only-encryption-key-32-chars!';

describe('secret encryption', () => {
  it('round-trips a session string', () => {
    const session = '1BQANOTEuMTA4LjU2LjE1NAG7q...fake-session';
    const enc = encryptSecret(session, KEY);
    expect(enc).not.toContain('fake-session');
    expect(decryptSecret(enc, KEY)).toBe(session);
  });

  it('produces a different ciphertext every time (fresh IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('fails on a wrong key', () => {
    const enc = encryptSecret('secret', KEY);
    expect(() => decryptSecret(enc, 'another-key-that-is-also-32-chars!!')).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptSecret('garbage', KEY)).toThrow('unrecognized secret format');
  });
});

describe('crypto — legacy v1 payloads', () => {
  it('still decrypts v1 (static-salt) secrets, but writes v2', () => {
    const key = 'a-32-char-minimum-encryption-key!!';
    // reproduce the old v1 writer
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(key, 'pierre-relay-v1', 32), iv);
    const enc = Buffer.concat([cipher.update('legacy session', 'utf8'), cipher.final()]);
    const v1 = `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;

    expect(decryptSecret(v1, key)).toBe('legacy session');
    expect(encryptSecret('new session', key)).toMatch(/^v2:/);
  });
});
