import { GrammyError } from 'grammy';
import type { Message } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { BotApiTransport, mapBotError, toRelayMessage } from '../src/transport/botapi';
import type { AlbumItem, SendOptions } from '../src/transport/transport';

const FROM = '-1004464666032';
const TO = '-1003770872984';

/** A bot transport whose Telegram API calls are recorded instead of sent. */
function recordingBot() {
  const t = new BotApiTransport('acc-bot', '123456:TEST-TOKEN');
  let nextId = 900;
  const calls: { method: string; args: unknown[] }[] = [];
  const stub = (method: string, result: (...args: unknown[]) => unknown) => {
    (t.bot.api as unknown as Record<string, unknown>)[method] = vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args });
      return result(...args);
    });
  };
  stub('sendMessage', () => ({ message_id: nextId++ }));
  stub('copyMessage', () => ({ message_id: nextId++ }));
  stub('copyMessages', (_to, _from, ids) => (ids as number[]).map(() => ({ message_id: nextId++ })));
  stub('sendMediaGroup', (_to, media) => (media as unknown[]).map(() => ({ message_id: nextId++ })));
  stub('forwardMessage', () => ({ message_id: nextId++ }));
  stub('forwardMessages', (_to, _from, ids) => (ids as number[]).map(() => ({ message_id: nextId++ })));
  stub('deleteMessages', () => true);
  return { t, calls };
}

const text = (s: string) => ({ text: s, entities: [] });

const send = (over: Partial<SendOptions>): SendOptions => ({
  fromChatId: FROM,
  toChatId: TO,
  srcMessageIds: [10],
  text: text(''),
  silent: false,
  removeButtons: false,
  mediaKind: 'text',
  ...over,
});

describe('bot copy — every content type reaches the receiver', () => {
  it('text → sendMessage with the transformed text and its formatting', async () => {
    const { t, calls } = recordingBot();
    const ids = await t.copy(send({ text: { text: 'LONG gold', entities: [{ type: 'bold', offset: 0, length: 4 }] } }));

    expect(ids).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendMessage');
    expect(calls[0]!.args[1]).toBe('LONG gold');
    expect((calls[0]!.args[2] as { entities: unknown[] }).entities).toEqual([
      { type: 'bold', offset: 0, length: 4 },
    ]);
  });

  it.each(['photo', 'video', 'animation', 'document', 'audio', 'voice'])(
    '%s → copyMessage by reference (no re-upload) with the transformed caption',
    async (kind) => {
      const { t, calls } = recordingBot();
      await t.copy(send({ mediaKind: kind, text: text('Chart for today') }));

      expect(calls.map((c) => c.method)).toEqual(['copyMessage']);
      expect(calls[0]!.args.slice(0, 3)).toEqual([Number(TO), Number(FROM), 10]);
      expect((calls[0]!.args[3] as { caption?: string }).caption).toBe('Chart for today');
    },
  );

  it('a PDF whose caption the rules removed does not leak the original caption', async () => {
    const { t, calls } = recordingBot();
    await t.copy(send({ mediaKind: 'document', text: text('') }));

    expect(calls.map((c) => c.method)).toEqual(['copyMessages']);
    expect(calls[0]!.args[2]).toEqual([10]);
    expect((calls[0]!.args[3] as { remove_caption?: boolean }).remove_caption).toBe(true);
  });

  it.each(['sticker', 'poll', 'other'])(
    '%s (no caption possible) → copyMessage WITHOUT a caption, so Telegram accepts it',
    async (kind) => {
      const { t, calls } = recordingBot();
      await t.copy(send({ mediaKind: kind, text: text('via Gold Signals') }));

      expect(calls.map((c) => c.method)).toEqual(['copyMessage']);
      expect(calls[0]!.args[3]).not.toHaveProperty('caption');
    },
  );

  it('photo album → ONE sendMediaGroup: grouped, caption on the first item, spoiler kept', async () => {
    const { t, calls } = recordingBot();
    const items: AlbumItem[] = [
      { messageId: 21, media: 'photo', fileId: 'photo-A' },
      { messageId: 22, media: 'photo', fileId: 'photo-B', hasSpoiler: true },
      { messageId: 23, media: 'video', fileId: 'video-C' },
    ];
    const ids = await t.copy(
      send({ mediaKind: 'photo', srcMessageIds: [21, 22, 23], items, text: text('3 setups') }),
    );

    expect(ids).toHaveLength(3);
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
    expect(calls[0]!.args[1]).toEqual([
      { type: 'photo', media: 'photo-A', caption: '3 setups', caption_entities: [] },
      { type: 'photo', media: 'photo-B', has_spoiler: true },
      { type: 'video', media: 'video-C' },
    ]);
  });

  it('album of PDFs → ONE sendMediaGroup of documents', async () => {
    const { t, calls } = recordingBot();
    const items: AlbumItem[] = [
      { messageId: 31, media: 'document', fileId: 'pdf-1' },
      { messageId: 32, media: 'document', fileId: 'pdf-2' },
    ];
    await t.copy(send({ mediaKind: 'document', srcMessageIds: [31, 32], items, text: text('Reports') }));

    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
    expect((calls[0]!.args[1] as { type: string }[]).map((m) => m.type)).toEqual(['document', 'document']);
  });

  it('a resumed album carries no caption (it went out with the first attempt)', async () => {
    const { t, calls } = recordingBot();
    const items: AlbumItem[] = [
      { messageId: 42, media: 'photo', fileId: 'p2' },
      { messageId: 43, media: 'photo', fileId: 'p3' },
    ];
    await t.copy(
      send({ mediaKind: 'photo', srcMessageIds: [42, 43], items, text: text('caption'), applyCaption: false }),
    );
    const media = calls[0]!.args[1] as Record<string, unknown>[];
    expect(media.every((m) => !('caption' in m))).toBe(true);
  });

  it('forward mode keeps an album grouped with ONE forwardMessages call', async () => {
    const { t, calls } = recordingBot();
    const ids = await t.forward({
      fromChatId: FROM, toChatId: TO, srcMessageIds: [51, 52, 53], silent: true, mediaKind: 'photo',
    });
    expect(ids).toHaveLength(3);
    expect(calls.map((c) => c.method)).toEqual(['forwardMessages']);
  });

  it('deleting a relayed album removes every item in one call', async () => {
    const { t, calls } = recordingBot();
    await t.deleteMessages(TO, [901, 902, 903]);
    expect(calls).toEqual([{ method: 'deleteMessages', args: [Number(TO), [901, 902, 903]] }]);
  });
});

describe('toRelayMessage — incoming posts keep what we need to re-send them', () => {
  const base = { message_id: 7, date: 1, chat: { id: Number(FROM), type: 'channel', title: 'M' } };

  it('photo: largest size, caption, album key, spoiler', () => {
    const m = toRelayMessage({
      ...base,
      media_group_id: 'grp1',
      caption: 'Setup',
      has_media_spoiler: true,
      photo: [
        { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
        { file_id: 'large', file_unique_id: 'l', width: 1280, height: 1280 },
      ],
    } as unknown as Message);
    expect(m).toMatchObject({
      media: 'photo', fileId: 'large', albumKey: 'grp1', hasSpoiler: true, text: { text: 'Setup' },
    });
  });

  it.each([
    ['document', { document: { file_id: 'pdf', file_unique_id: 'u' } }],
    ['video', { video: { file_id: 'vid', file_unique_id: 'u', width: 1, height: 1, duration: 1 } }],
    ['voice', { voice: { file_id: 'vo', file_unique_id: 'u', duration: 1 } }],
    ['audio', { audio: { file_id: 'au', file_unique_id: 'u', duration: 1 } }],
  ])('%s gets its file id', (media, payload) => {
    const m = toRelayMessage({ ...base, ...payload } as unknown as Message);
    expect(m.media).toBe(media);
    expect(m.fileId).toBeTruthy();
  });

  it('a GIF is an animation, not a document', () => {
    const m = toRelayMessage({
      ...base,
      animation: { file_id: 'gif', file_unique_id: 'u', width: 1, height: 1, duration: 1 },
      document: { file_id: 'gif', file_unique_id: 'u' },
    } as unknown as Message);
    expect(m.media).toBe('animation');
  });
});

describe('mapBotError — blame the right thing', () => {
  const tgError = (code: number, description: string, retryAfter?: number) =>
    new GrammyError(
      description,
      { ok: false, error_code: code, description, parameters: retryAfter ? { retry_after: retryAfter } : {} },
      'copyMessage',
      {},
    );

  it.each([
    [429, 'Too Many Requests: retry after 7', 'flood_wait'],
    [401, 'Unauthorized', 'session_revoked'],
    [403, 'Forbidden: bot is not a member of the channel chat', 'forbidden'],
    [400, 'Bad Request: not enough rights to send photos to the chat', 'forbidden'],
    [400, 'Bad Request: chat not found', 'not_found'],
    [400, "Bad Request: message has protected content and can't be forwarded", 'protected'],
    [400, 'Bad Request: message to copy not found', 'rejected'],
    [400, "Bad Request: message can't be copied", 'rejected'],
    [500, 'Internal Server Error', 'unknown'],
  ])('%s %s → %s', (code, description, expected) => {
    expect(mapBotError(tgError(code, description, code === 429 ? 7 : undefined)).code).toBe(expected);
  });
});

describe('forum topics (groups with Topics enabled)', () => {
  const forum = { id: -1005000000001, type: 'supergroup', title: 'Signals forum', is_forum: true };

  it('a message in a topic carries that topic id', () => {
    const m = toRelayMessage({
      message_id: 40, date: 1, chat: forum, text: 'hi',
      is_topic_message: true, message_thread_id: 12,
    } as unknown as Message);
    expect(m.topicId).toBe(12);
  });

  it('a forum message outside any topic belongs to General (1)', () => {
    const m = toRelayMessage({ message_id: 41, date: 1, chat: forum, text: 'hi' } as unknown as Message);
    expect(m.topicId).toBe(1);
  });

  it('reply threads in an ordinary group are NOT topics', () => {
    const m = toRelayMessage({
      message_id: 42, date: 1, text: 'reply',
      chat: { id: -1005000000002, type: 'supergroup', title: 'Normal group' },
      message_thread_id: 30,
    } as unknown as Message);
    expect(m.topicId).toBeUndefined();
  });

  it('posts into the chosen topic: text, media, album and forward all pass message_thread_id', async () => {
    const { t, calls } = recordingBot();
    await t.copy(send({ text: text('hello topic'), topicId: 12 }));
    await t.copy(send({ mediaKind: 'document', text: text('pdf'), topicId: 12 }));
    await t.copy(
      send({
        mediaKind: 'photo', srcMessageIds: [1, 2], topicId: 12, text: text('album'),
        items: [
          { messageId: 1, media: 'photo', fileId: 'a' },
          { messageId: 2, media: 'photo', fileId: 'b' },
        ],
      }),
    );
    await t.forward({ fromChatId: FROM, toChatId: TO, srcMessageIds: [5], silent: false, mediaKind: 'text', topicId: 12 });

    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'copyMessage', 'sendMediaGroup', 'forwardMessage']);
    for (const call of calls) {
      expect(call.args.at(-1)).toMatchObject({ message_thread_id: 12 });
    }
  });

  it('General (1) and no topic send without a thread id', async () => {
    const { t, calls } = recordingBot();
    await t.copy(send({ text: text('general'), topicId: 1 }));
    await t.copy(send({ text: text('plain group') }));
    for (const call of calls) expect(call.args.at(-1)).not.toHaveProperty('message_thread_id');
  });
});
