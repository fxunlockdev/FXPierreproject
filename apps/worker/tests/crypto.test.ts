import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto.js';

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
