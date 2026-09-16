import { describe, expect, it } from 'vitest';
import { BotApiTransport } from '../src/transport/botapi';

describe('BotApiTransport.normalizeRef — every way people paste a chat', () => {
  it.each([
    ['@gold_signals', '@gold_signals'],
    ['gold_signals', '@gold_signals'],
    ['https://t.me/gold_signals', '@gold_signals'],
    ['t.me/gold_signals', '@gold_signals'],
    ['https://t.me/gold_signals/1234', '@gold_signals'], // public post link
    ['https://t.me/s/gold_signals', '@gold_signals'], // web preview link
    ['https://t.me/gold_signals?start=x', '@gold_signals'],
    ['  @gold_signals  ', '@gold_signals'],
  ])('%s → %s', (input, expected) => {
    expect(BotApiTransport.normalizeRef(input)).toBe(expected);
  });

  it.each([
    ['-1001234567890', -1001234567890], // channel / supergroup id
    ['-4123456789', -4123456789], // basic group id
    ['https://t.me/c/1234567890/55', -1001234567890], // private post link
    ['t.me/c/1234567890/12/55', -1001234567890], // forum topic post link
  ])('%s → chat id %s', (input, expected) => {
    expect(BotApiTransport.normalizeRef(input)).toBe(expected);
  });

  it.each(['https://t.me/+pupW9jQoK1AxYzE0', 't.me/+t16v76XHe2k3ODQ0', 'https://t.me/joinchat/AbCdEf'])(
    'rejects invite link %s with guidance instead of a cryptic "chat not found"',
    (input) => {
      expect(() => BotApiTransport.normalizeRef(input)).toThrow(/invite links.*Chats the bot can see/);
    },
  );
});
