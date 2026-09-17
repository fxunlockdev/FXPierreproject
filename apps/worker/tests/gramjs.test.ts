import { Api, helpers } from 'telegram';
import { describe, expect, it, vi } from 'vitest';
import { GramJsTransport, NOT_ANONYMOUS_ADMIN, sentIds, topicIdOf } from '../src/transport/gramjs';
import type { SendOptions } from '../src/transport/transport';

const big = (n: number | string) => helpers.returnBigInt(n);

const GROUP_ID = 4396952075; // ICEBERG, a supergroup with topics
const GROUP = `-100${GROUP_ID}`;
const CHANNEL_ID = 1234567890;
const CHANNEL = `-100${CHANNEL_ID}`;
const MASTER = '-1004464666032';

const inputChannel = (id: number) => new Api.InputPeerChannel({ channelId: big(id), accessHash: big(42) });

const photo = (id: number) =>
  new Api.MessageMediaPhoto({
    photo: new Api.Photo({ id: big(id), accessHash: big(7), fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 2 }),
  });

/**
 * A user-account transport whose MTProto calls are answered locally.
 * `anonymousIn` lists the groups where the account may post as the group.
 */
function userAccount(opts: { anonymousIn?: number[]; sourceMedia?: Api.TypeMessageMedia[] } = {}) {
  const t = new GramJsTransport('acc-user', 1, 'hash', '');
  const requests: Api.AnyRequest[] = [];
  let nextId = 700;
  const client = t.client as unknown as Record<string, unknown>;

  client['getInputEntity'] = vi.fn(async (ref: unknown) => {
    const id = String(ref);
    if (id === GROUP) return inputChannel(GROUP_ID);
    if (id === CHANNEL) return inputChannel(CHANNEL_ID);
    if (id === MASTER) return inputChannel(4464666032);
    throw new Error(`unknown peer ${id}`);
  });
  client['getEntity'] = vi.fn(async (peer: Api.InputPeerChannel) =>
    new Api.Channel({
      id: peer.channelId,
      title: 'x',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
      megagroup: peer.channelId.equals(big(GROUP_ID)),
      broadcast: !peer.channelId.equals(big(GROUP_ID)),
    }),
  );
  client['getMessages'] = vi.fn(async () => (opts.sourceMedia ?? []).map((media) => ({ media })));
  client['invoke'] = vi.fn(async (req: Api.AnyRequest) => {
    requests.push(req);
    if (req instanceof Api.channels.GetSendAs) {
      return new Api.channels.SendAsPeers({
        peers: [
          new Api.SendAsPeer({ peer: new Api.PeerUser({ userId: big(99) }) }),
          ...(opts.anonymousIn ?? []).map(
            (id) => new Api.SendAsPeer({ peer: new Api.PeerChannel({ channelId: big(id) }) }),
          ),
        ],
        chats: [],
        users: [],
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
  const sends = () => requests.filter((r) => !(r instanceof Api.channels.GetSendAs));
  return { t, requests, sends };
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
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID] });
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
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID] });
    await t.copy(send({ topicId: 1 }));
    expect((sends()[0] as Api.messages.SendMessage).replyTo).toBeUndefined();
  });

  it('refuses rather than post under the account\'s own name when it is not an anonymous admin', async () => {
    const { t, sends } = userAccount({ anonymousIn: [] });
    await expect(t.copy(send({}))).rejects.toMatchObject({ code: 'forbidden', message: NOT_ANONYMOUS_ADMIN });
    expect(sends()).toHaveLength(0);
  });

  it('checks the group once, not on every post', async () => {
    const { t, requests } = userAccount({ anonymousIn: [GROUP_ID] });
    await t.copy(send({}));
    await t.copy(send({}));
    expect(requests.filter((r) => r instanceof Api.channels.GetSendAs)).toHaveLength(1);
  });

  it('after a failed send the group is checked again, so a revoked "Remain anonymous" is noticed at once', async () => {
    const { t, requests } = userAccount({ anonymousIn: [GROUP_ID] });
    await t.copy(send({}));
    const invoke = t.client.invoke as unknown as ReturnType<typeof vi.fn>;
    const answer = invoke.getMockImplementation()!;
    invoke.mockImplementationOnce(async () => {
      throw Object.assign(new Error('SEND_AS_PEER_INVALID'), { errorMessage: 'SEND_AS_PEER_INVALID' });
    });
    await expect(t.copy(send({}))).rejects.toBeDefined();
    invoke.mockImplementation(answer);
    await t.copy(send({}));
    expect(requests.filter((r) => r instanceof Api.channels.GetSendAs)).toHaveLength(2);
  });

  it('a broadcast channel needs no send-as: posts there always show the channel', async () => {
    const { t, requests } = userAccount();
    await t.copy(send({ toChatId: CHANNEL }));
    expect(requests.some((r) => r instanceof Api.channels.GetSendAs)).toBe(false);
    expect((requests[0] as Api.messages.SendMessage).sendAs).toBeUndefined();
  });

  it('a photo is re-sent by reference with the transformed caption', async () => {
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID], sourceMedia: [photo(1)] });
    const ids = await t.copy(send({ mediaKind: 'photo' }));

    expect(ids).toEqual([700]);
    const [req] = sends() as Api.messages.SendMedia[];
    expect(req).toBeInstanceOf(Api.messages.SendMedia);
    expect(req!.media).toBeInstanceOf(Api.InputMediaPhoto);
    expect(req!.message).toBe('SELL GOLD 4312.5');
    expect(req!.sendAs).toBeDefined();
  });

  it('an album goes out as one grouped send, caption on the first item only', async () => {
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID], sourceMedia: [photo(1), photo(2), photo(3)] });
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
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID], sourceMedia: [photo(2), photo(3)] });
    await t.copy(send({ mediaKind: 'photo', srcMessageIds: [11, 12], applyCaption: false }));
    expect((sends()[0] as Api.messages.SendMultiMedia).multiMedia.map((m) => m.message)).toEqual(['', '']);
  });

  it('forward mode keeps the header, lands in the topic and posts as the group', async () => {
    const { t, sends } = userAccount({ anonymousIn: [GROUP_ID] });
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

  it('chat ids reach GramJS as numbers, never as strings it would read as phone numbers', async () => {
    const { t } = userAccount({ anonymousIn: [GROUP_ID] });
    await t.copy(send({}));
    const refs = (t.client.getInputEntity as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(refs.every((r) => typeof r !== 'string')).toBe(true);
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
