import { Api, helpers } from 'telegram';
import { describe, expect, it, vi } from 'vitest';
import { GramJsTransport, NOT_ANONYMOUS_ADMIN, NOT_IN_CHAT, sentIds, topicIdOf } from '../src/transport/gramjs';
import type { SendOptions } from '../src/transport/transport';

const big = (n: number | string) => helpers.returnBigInt(n);

const GROUP_ID = 4396952075; // ICEBERG, a supergroup with topics
const GROUP = `-100${GROUP_ID}`;
const CHANNEL_ID = 1234567890;
const CHANNEL = `-100${CHANNEL_ID}`;
const MASTER = '-1004464666032';

const photo = (id: number) =>
  new Api.MessageMediaPhoto({
    photo: new Api.Photo({ id: big(id), accessHash: big(7), fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 2 }),
  });

const chat = (id: number, kind: 'group' | 'channel', forum = false) =>
  new Api.Channel({
    id: big(id),
    accessHash: big(42),
    title: kind === 'group' ? 'ICEBERG' : 'Channel',
    photo: new Api.ChatPhotoEmpty(),
    date: 0,
    megagroup: kind === 'group',
    broadcast: kind === 'channel',
    forum,
  });

type Participant = 'anonymous-admin' | 'admin' | 'member' | 'outside';

/**
 * A user-account transport whose MTProto calls are answered locally.
 * `participant` is what the account is in the group; `dialogs` is its chat list.
 */
function userAccount(
  opts: {
    sourceMedia?: Api.TypeMessageMedia[];
    dialogs?: (Api.Channel | Api.ChannelForbidden)[];
    participant?: Participant;
  } = {},
) {
  const t = new GramJsTransport('acc-user', 1, 'hash', '');
  const requests: Api.AnyRequest[] = [];
  let nextId = 700;
  const client = t.client as unknown as Record<string, unknown>;
  const state: {
    dialogs: (Api.Channel | Api.ChannelForbidden)[];
    /** Telegram's error for this request, when the test wants one. */
    failWith: (req: Api.AnyRequest) => string | undefined;
  } = {
    dialogs: opts.dialogs ?? [chat(GROUP_ID, 'group', true), chat(CHANNEL_ID, 'channel'), chat(4464666032, 'channel')],
    failWith: () => undefined,
  };

  client['getDialogs'] = vi.fn(async () => state.dialogs.map((entity) => ({ entity })));
  client['getEntity'] = vi.fn(async (peer: Api.InputPeerChannel) =>
    state.dialogs.find((d) => d.id.equals(peer.channelId)) ?? chat(Number(peer.channelId), 'channel'),
  );
  client['getMessages'] = vi.fn(async () => (opts.sourceMedia ?? []).map((media) => ({ media })));
  client['invoke'] = vi.fn(async (req: Api.AnyRequest) => {
    requests.push(req);
    const failure = state.failWith(req);
    if (failure) throw Object.assign(new Error(failure), { errorMessage: failure });
    if (req instanceof Api.channels.GetParticipant) {
      const role = opts.participant ?? 'anonymous-admin';
      if (role === 'outside') throw Object.assign(new Error('USER_NOT_PARTICIPANT'), { errorMessage: 'USER_NOT_PARTICIPANT' });
      const participant =
        role === 'member'
          ? new Api.ChannelParticipantSelf({ userId: big(99), inviterId: big(1), date: 0 })
          : new Api.ChannelParticipantAdmin({
              userId: big(99),
              promotedBy: big(1),
              date: 0,
              adminRights: new Api.ChatAdminRights({ anonymous: role === 'anonymous-admin', postMessages: true }),
            });
      return new Api.channels.ChannelParticipant({ participant, chats: [], users: [] });
    }
    if (req instanceof Api.channels.GetForumTopicsByID) {
      return new Api.messages.ForumTopics({
        count: 1,
        topics: [new Api.ForumTopic({ id: 5, date: 0, title: 'GOLD Scalp', iconColor: 0, topMessage: 5, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, fromId: new Api.PeerUser({ userId: big(1) }), notifySettings: new Api.PeerNotifySettings({}) })],
        messages: [],
        chats: [],
        users: [],
        pts: 0,
      });
    }
    const randomIds =
      req instanceof Api.messages.SendMultiMedia
        ? req.multiMedia.map((m) => m.randomId)
        : req instanceof Api.messages.ForwardMessages
          ? req.randomId
          : [(req as Api.messages.SendMessage).randomId];
    return new Api.Updates({
      updates: randomIds.map((randomId) => new Api.UpdateMessageID({ id: nextId++, randomId })),
      users: [],
      chats: [],
      date: 0,
      seq: 0,
    });
  });
  const sends = () =>
    requests.filter(
      (r) =>
        r instanceof Api.messages.SendMessage ||
        r instanceof Api.messages.SendMedia ||
        r instanceof Api.messages.SendMultiMedia ||
        r instanceof Api.messages.ForwardMessages,
    );
  return { t, requests, sends, state };
}

const send = (over: Partial<SendOptions>): SendOptions => ({
  fromChatId: MASTER,
  toChatId: GROUP,
  srcMessageIds: [10],
  text: { text: 'SELL GOLD 4312.5', entities: [{ type: 'bold', offset: 0, length: 4 }] },
  silent: false,
  removeButtons: false,
  mediaKind: 'text',
  ...over,
});

describe('user account posting into a group — appears as the group', () => {
  it('an anonymous admin posts as the group itself, into the chosen topic', async () => {
    const { t, sends } = userAccount();
    const ids = await t.copy(send({ topicId: 5 }));

    expect(ids).toEqual([700]);
    const [req] = sends() as Api.messages.SendMessage[];
    expect(req).toBeInstanceOf(Api.messages.SendMessage);
    expect(req!.message).toBe('SELL GOLD 4312.5');
    expect((req!.sendAs as Api.InputPeerChannel).channelId.equals(big(GROUP_ID))).toBe(true);
    expect((req!.replyTo as Api.InputReplyToMessage).replyToMsgId).toBe(5);
    expect(req!.entities).toHaveLength(1);
  });

  it('General needs no topic reference', async () => {
    const { t, sends } = userAccount();
    await t.copy(send({ topicId: 1 }));
    expect((sends()[0] as Api.messages.SendMessage).replyTo).toBeUndefined();
  });

  it('refuses rather than post under the account\'s own name when it is not an anonymous admin', async () => {
    const { t, sends } = userAccount({ participant: 'admin' });
    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'forbidden', message: NOT_ANONYMOUS_ADMIN });
    expect(sends()).toHaveLength(0);
  });

  it("checks the group's rights once, not on every post", async () => {
    const { t, requests } = userAccount();
    await t.copy(send({}));
    await t.copy(send({}));
    expect(requests.filter((r) => r instanceof Api.channels.GetParticipant)).toHaveLength(1);
  });

  it('after a failed send the group is checked again, so a revoked "Remain anonymous" is noticed at once', async () => {
    const { t, requests, state } = userAccount();
    await t.copy(send({}));

    state.failWith = (req) => (req instanceof Api.messages.SendMessage ? 'PEER_ID_INVALID' : undefined);
    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'not_found' });

    state.failWith = () => undefined;
    await t.copy(send({}));
    expect(requests.filter((r) => r instanceof Api.channels.GetParticipant)).toHaveLength(2);
  });

  it('a broadcast channel needs no send-as: posts there always show the channel', async () => {
    const { t, requests, sends } = userAccount();
    await t.copy(send({ toChatId: CHANNEL }));
    expect(requests.some((r) => r instanceof Api.channels.GetParticipant)).toBe(false);
    expect((sends()[0] as Api.messages.SendMessage).sendAs).toBeUndefined();
  });

  it('if Telegram refuses send-as, the post still goes out — once, under the group default', async () => {
    const { t, sends, state } = userAccount();
    state.failWith = (req) =>
      req instanceof Api.messages.SendMessage && req.sendAs ? 'SEND_AS_PEER_INVALID' : undefined;

    const ids = await t.copy(send({}));

    expect(ids).toEqual([700]);
    const attempts = sends() as Api.messages.SendMessage[];
    expect(attempts.map((r) => Boolean(r.sendAs))).toEqual([true, false]);
    // the same random id: a message that did land can never be sent twice
    expect(attempts[0]!.randomId!.toString()).toBe(attempts[1]!.randomId!.toString());
  });

  it('a photo is re-sent by reference with the transformed caption', async () => {
    const { t, sends } = userAccount({ sourceMedia: [photo(1)] });
    const ids = await t.copy(send({ mediaKind: 'photo' }));

    expect(ids).toEqual([700]);
    const [req] = sends() as Api.messages.SendMedia[];
    expect(req).toBeInstanceOf(Api.messages.SendMedia);
    expect(req!.media).toBeInstanceOf(Api.InputMediaPhoto);
    expect(req!.message).toBe('SELL GOLD 4312.5');
    expect(req!.sendAs).toBeDefined();
  });

  it('an album goes out as one grouped send, caption on the first item only', async () => {
    const { t, sends } = userAccount({ sourceMedia: [photo(1), photo(2), photo(3)] });
    const checkpoints: number[][] = [];
    const ids = await t.copy(
      send({ mediaKind: 'photo', srcMessageIds: [10, 11, 12], topicId: 5, onSent: (so) => void checkpoints.push(so) }),
    );

    expect(ids).toEqual([700, 701, 702]);
    expect(checkpoints).toEqual([[700, 701, 702]]);
    const [req] = sends() as Api.messages.SendMultiMedia[];
    expect(req).toBeInstanceOf(Api.messages.SendMultiMedia);
    expect(req!.multiMedia.map((m) => m.message)).toEqual(['SELL GOLD 4312.5', '', '']);
    expect((req!.replyTo as Api.InputReplyToMessage).replyToMsgId).toBe(5);
  });

  it('an album resume carries no caption', async () => {
    const { t, sends } = userAccount({ sourceMedia: [photo(2), photo(3)] });
    await t.copy(send({ mediaKind: 'photo', srcMessageIds: [11, 12], applyCaption: false }));
    expect((sends()[0] as Api.messages.SendMultiMedia).multiMedia.map((m) => m.message)).toEqual(['', '']);
  });

  it('forward mode keeps the header, lands in the topic and posts as the group', async () => {
    const { t, sends } = userAccount();
    const ids = await t.forward({
      fromChatId: MASTER,
      toChatId: GROUP,
      srcMessageIds: [10, 11],
      silent: true,
      mediaKind: 'photo',
      topicId: 5,
    });

    expect(ids).toEqual([700, 701]);
    const [req] = sends() as Api.messages.ForwardMessages[];
    expect(req!.topMsgId).toBe(5);
    expect(req!.silent).toBe(true);
    expect(req!.sendAs).toBeDefined();
  });

});

describe('user account — finding the chat, and recovering when it cannot', () => {
  it('a chat the account is not in fails with a clear reason and nothing is sent', async () => {
    const { t, sends } = userAccount({ dialogs: [chat(CHANNEL_ID, 'channel')] });
    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'not_found', message: NOT_IN_CHAT });
    expect(sends()).toHaveLength(0);
  });

  it('a group the account was removed from is not used, even though it still shows in its chat list', async () => {
    const forbidden = new Api.ChannelForbidden({ id: big(GROUP_ID), accessHash: big(42), title: 'ICEBERG', megagroup: true });
    const { t, sends } = userAccount({ dialogs: [forbidden] });
    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'not_found' });
    expect(sends()).toHaveLength(0);
  });

  it('a group joined after the relay started is found once the chat list is reloaded', async () => {
    const { t, state, sends } = userAccount({ dialogs: [chat(CHANNEL_ID, 'channel')] });
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'not_found' });

      state.dialogs = [chat(CHANNEL_ID, 'channel'), chat(GROUP_ID, 'group', true)]; // added to the group
      now.mockReturnValue(1_000_000 + 61_000);
      await expect(t.copy(send({}))).resolves.toEqual([700]);
      expect(sends()).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('PEER_ID_INVALID on a send becomes a readable reason and forces a fresh lookup next time', async () => {
    const { t, state } = userAccount();
    state.failWith = (req) => (req instanceof Api.messages.SendMessage ? 'PEER_ID_INVALID' : undefined);

    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.copy(send({}))).rejects.toThrow(/isn't in that chat.*PEER_ID_INVALID/);

    const dialogs = t.client.getDialogs as unknown as ReturnType<typeof vi.fn>;
    expect(dialogs.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('copying a photo from a master the account has not joined says to join it', async () => {
    const { t } = userAccount({
      sourceMedia: [photo(1)],
      dialogs: [chat(GROUP_ID, 'group', true)],
    });
    await expect(t.copy(send({ mediaKind: 'photo' }))).rejects.toMatchObject({ code: 'rejected' });
    await expect(t.copy(send({ mediaKind: 'photo' }))).rejects.toThrow(/join it/);
  });
});

describe('Check this account — what is missing, in plain words', () => {
  const failing = (checks: { label: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.label);

  it('an anonymous admin passes every check, including the topic', async () => {
    const { t, sends } = userAccount();
    const checks = await t.checkAccess(GROUP, 5);
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.label)).toEqual([
      'The account is in this chat',
      'Admin in the group',
      'Remain Anonymous is on',
      'The topic exists',
    ]);
    expect(sends()).toHaveLength(0); // checking never posts anything
  });

  it('an admin without Remain Anonymous is told exactly that', async () => {
    const { t } = userAccount({ participant: 'admin' });
    const checks = await t.checkAccess(GROUP, null);
    expect(failing(checks)).toEqual(['Remain Anonymous is on']);
    expect(checks.find((c) => c.label === 'Remain Anonymous is on')!.detail).toMatch(/switch on Remain Anonymous/);
  });

  it('a plain member is told to make it an admin', async () => {
    const { t } = userAccount({ participant: 'member' });
    const checks = await t.checkAccess(GROUP, null);
    expect(failing(checks)).toEqual(['Admin in the group']);
    expect(checks[1]!.detail).toMatch(/not an admin/);
  });

  it('an account that is not in the group stops at the first check', async () => {
    const { t } = userAccount({ dialogs: [chat(CHANNEL_ID, 'channel')] });
    const checks = await t.checkAccess(GROUP, null);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ label: 'The account is in this chat', ok: false });
  });

  it('a channel only needs admin with Post Messages', async () => {
    const { t } = userAccount({ participant: 'admin' });
    const checks = await t.checkAccess(CHANNEL, null);
    expect(checks.map((c) => [c.label, c.ok])).toEqual([
      ['The account is in this chat', true],
      ['Admin with Post Messages', true],
    ]);
  });
});

describe('reading topics with a user account', () => {
  const channel = (forum: boolean) =>
    new Api.Channel({ id: big(GROUP_ID), title: 'ICEBERG', photo: new Api.ChatPhotoEmpty(), date: 0, megagroup: true, forum });

  const message = (over: Partial<Api.Message>, chat: Api.Channel) => {
    const m = new Api.Message({ id: 1, peerId: new Api.PeerChannel({ channelId: big(GROUP_ID) }), date: 0, message: 'x', ...over });
    (m as unknown as { _chat: Api.Channel })._chat = chat;
    return m;
  };

  it('a message inside a topic reports that topic', () => {
    const m = message({ replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 5 }) }, channel(true));
    expect(topicIdOf(m)).toBe(5);
  });

  it('a reply inside a topic still reports the topic, not the replied message', () => {
    const m = message(
      { replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 812, replyToTopId: 5 }) },
      channel(true),
    );
    expect(topicIdOf(m)).toBe(5);
  });

  it('General in a group with topics, nothing in a group without', () => {
    expect(topicIdOf(message({}, channel(true)))).toBe(1);
    expect(topicIdOf(message({}, channel(false)))).toBeUndefined();
  });
});

describe('sentIds', () => {
  it('maps random ids back to message ids in request order', () => {
    const updates = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 2, randomId: big(20) }),
        new Api.UpdateMessageID({ id: 1, randomId: big(10) }),
      ],
      users: [],
      chats: [],
      date: 0,
      seq: 0,
    });
    expect(sentIds(updates, [big(10), big(20)])).toEqual([1, 2]);
  });
});
