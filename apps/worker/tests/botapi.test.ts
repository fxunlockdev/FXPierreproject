import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
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

describe('BotApiTransport.checkTopic — confirming a topic added by link', () => {
  const failWith = (description: string, code = 400) =>
    new GrammyError(description, { ok: false, error_code: code, description }, 'sendChatAction', {});

  function botWith(sendChatAction: (...args: unknown[]) => Promise<unknown>) {
    const t = new BotApiTransport('acc-bot', '123456:TEST-TOKEN');
    const spy = vi.fn(sendChatAction);
    (t.bot.api as unknown as Record<string, unknown>)['sendChatAction'] = spy;
    return { t, spy };
  }

  it('aims a chat action at the thread and posts nothing', async () => {
    const { t, spy } = botWith(async () => true);
    await expect(t.checkTopic('-1004396952075', 5)).resolves.toEqual({});
    expect(spy).toHaveBeenCalledWith(-1004396952075, 'typing', { message_thread_id: 5 });
  });

  it.each(['Bad Request: message thread not found', 'Bad Request: TOPIC_ID_INVALID', 'Bad Request: TOPIC_DELETED'])(
    'a missing topic (%s) is a definite "rejected"',
    async (description) => {
      const { t } = botWith(async () => {
        throw failWith(description);
      });
      await expect(t.checkTopic('-1004396952075', 99)).rejects.toMatchObject({ code: 'rejected' });
    },
  );

  it('a closed topic is rejected with a way out', async () => {
    const { t } = botWith(async () => {
      throw failWith('Bad Request: TOPIC_CLOSED');
    });
    await expect(t.checkTopic('-1004396952075', 7)).rejects.toThrow(/closed — reopen/);
  });

  it('a bot that is not in the group reports not_found, so another bot can try', async () => {
    const { t } = botWith(async () => {
      throw failWith('Bad Request: chat not found');
    });
    await expect(t.checkTopic('-1004396952075', 7)).rejects.toMatchObject({ code: 'not_found' });
  });
});
