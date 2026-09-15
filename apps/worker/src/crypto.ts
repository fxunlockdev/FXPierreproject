import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * AES-256-GCM at rest for Telegram sessions and bot tokens.
 * v2 format: v2:<salt b64>:<iv b64>:<tag b64>:<ciphertext b64> — the scrypt
 * salt is random per secret. v1 (static salt) is still decryptable so
 * existing rows keep working; every new write produces v2.
 */

const LEGACY_V1_SALT = 'pierre-relay-v1';

export function encryptSecret(plain: string, key: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${salt.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string, key: string): string {
  const parts = payload.split(':');
  let derived: Buffer;
  let ivB64: string | undefined;
  let tagB64: string | undefined;
  let dataB64: string | undefined;

  if (parts[0] === 'v2' && parts.length === 5) {
    derived = scryptSync(key, Buffer.from(parts[1]!, 'base64'), 32);
    [, , ivB64, tagB64, dataB64] = parts;
  } else if (parts[0] === 'v1' && parts.length === 4) {
    derived = scryptSync(key, LEGACY_V1_SALT, 32);
    [, ivB64, tagB64, dataB64] = parts;
  } else {
    throw new Error('unrecognized secret format');
  }
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('unrecognized secret format');

  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
