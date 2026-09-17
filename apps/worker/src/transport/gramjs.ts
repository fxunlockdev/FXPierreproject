import { Api, TelegramClient, errors, helpers, utils } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import type { Entity, MediaKind, RelayMessage, RichText } from '@pierre/core';
import {
  GENERAL_TOPIC_ID,
  TransportError,
  type AccessCheck,
  type ReaderHandlers,
  type ResolvedChannel,
  type SendOptions,
  type Transport,
} from './transport';

type GramMessage = Api.Message;

export function toApiEntities(entities: Entity[]): Api.TypeMessageEntity[] {
  const out: Api.TypeMessageEntity[] = [];
  for (const e of entities) {
    const base = { offset: e.offset, length: e.length };
    switch (e.type) {
      case 'bold': out.push(new Api.MessageEntityBold(base)); break;
      case 'italic': out.push(new Api.MessageEntityItalic(base)); break;
      case 'underline': out.push(new Api.MessageEntityUnderline(base)); break;
      case 'strikethrough': out.push(new Api.MessageEntityStrike(base)); break;
      case 'spoiler': out.push(new Api.MessageEntitySpoiler(base)); break;
      case 'code': out.push(new Api.MessageEntityCode(base)); break;
      case 'pre': out.push(new Api.MessageEntityPre({ ...base, language: e.language ?? '' })); break;
      case 'text_link': out.push(new Api.MessageEntityTextUrl({ ...base, url: e.url ?? '' })); break;
      case 'url': out.push(new Api.MessageEntityUrl(base)); break;
      case 'mention': out.push(new Api.MessageEntityMention(base)); break;
      case 'hashtag': out.push(new Api.MessageEntityHashtag(base)); break;
      case 'cashtag': out.push(new Api.MessageEntityCashtag(base)); break;
      case 'bot_command': out.push(new Api.MessageEntityBotCommand(base)); break;
      case 'email': out.push(new Api.MessageEntityEmail(base)); break;
      case 'phone': out.push(new Api.MessageEntityPhone(base)); break;
      case 'blockquote': out.push(new Api.MessageEntityBlockquote({ ...base })); break;
      default: break; // custom_emoji needs document ids — dropped on copy
    }
  }
  return out;
}

export function fromApiEntities(entities: Api.TypeMessageEntity[] | undefined): Entity[] {
  if (!entities) return [];
  const out: Entity[] = [];
  for (const e of entities) {
    const base = { offset: e.offset, length: e.length };
    switch (e.className) {
      case 'MessageEntityBold': out.push({ ...base, type: 'bold' }); break;
      case 'MessageEntityItalic': out.push({ ...base, type: 'italic' }); break;
      case 'MessageEntityUnderline': out.push({ ...base, type: 'underline' }); break;
      case 'MessageEntityStrike': out.push({ ...base, type: 'strikethrough' }); break;
      case 'MessageEntitySpoiler': out.push({ ...base, type: 'spoiler' }); break;
      case 'MessageEntityCode': out.push({ ...base, type: 'code' }); break;
      case 'MessageEntityPre':
        out.push({ ...base, type: 'pre', language: (e as Api.MessageEntityPre).language });
        break;
      case 'MessageEntityTextUrl':
        out.push({ ...base, type: 'text_link', url: (e as Api.MessageEntityTextUrl).url });
        break;
      case 'MessageEntityUrl': out.push({ ...base, type: 'url' }); break;
      case 'MessageEntityMention': out.push({ ...base, type: 'mention' }); break;
      case 'MessageEntityHashtag': out.push({ ...base, type: 'hashtag' }); break;
      case 'MessageEntityCashtag': out.push({ ...base, type: 'cashtag' }); break;
      case 'MessageEntityBotCommand': out.push({ ...base, type: 'bot_command' }); break;
      case 'MessageEntityEmail': out.push({ ...base, type: 'email' }); break;
      case 'MessageEntityPhone': out.push({ ...base, type: 'phone' }); break;
      case 'MessageEntityBlockquote': out.push({ ...base, type: 'blockquote' }); break;
      default: break;
    }
  }
  return out;
}

function mediaKindOf(m: GramMessage): MediaKind {
  if (m.photo) return 'photo';
  if (m.gif) return 'animation';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.sticker) return 'sticker';
  if (m.poll) return 'poll';
  if (m.document) return 'document';
  if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) return 'other';
  return 'text';
}

export function mapGramError(err: unknown): TransportError {
  if (err instanceof errors.FloodWaitError) {
    return new TransportError('flood_wait', `FLOOD_WAIT ${err.seconds}s`, err.seconds);
  }
  const message =
    (err as { errorMessage?: string }).errorMessage ??
    (err instanceof Error ? err.message : String(err));

  if (/FLOOD_WAIT_(\d+)/.test(message)) {
    const seconds = Number(/FLOOD_WAIT_(\d+)/.exec(message)?.[1] ?? 60);
    return new TransportError('flood_wait', message, seconds);
  }
  if (/CHAT_FORWARDS_RESTRICTED/.test(message)) return new TransportError('protected', message);
  if (/(CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_SEND_.*_FORBIDDEN|USER_BANNED_IN_CHANNEL)/.test(message)) {
    return new TransportError('forbidden', message);
  }
  if (/(CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|MESSAGE_ID_INVALID|MSG_ID_INVALID)/.test(message)) {
    return new TransportError('not_found', message);
  }
  if (/(AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED)/.test(message)) {
    return new TransportError('session_revoked', message);
  }
  if (/(TIMEDOUT|TIMEOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|Not connected)/i.test(message)) {
    return new TransportError('network', message);
  }
  return new TransportError('unknown', message);
}

/** Forum topic of a message: its thread for topic messages, General for the rest of a forum. */
export function topicIdOf(m: GramMessage): number | undefined {
  const header = m.replyTo;
  if (header instanceof Api.MessageReplyHeader && header.forumTopic) {
    return header.replyToTopId ?? header.replyToMsgId ?? GENERAL_TOPIC_ID;
  }
  const chat = m.chat;
  return chat instanceof Api.Channel && chat.forum ? GENERAL_TOPIC_ID : undefined;
}

/** A new message lands in a topic by "replying" to the topic's first message. */
const topicReply = (topicId: number | null | undefined): Api.InputReplyToMessage | undefined =>
  topicId && topicId !== GENERAL_TOPIC_ID ? new Api.InputReplyToMessage({ replyToMsgId: topicId }) : undefined;

/** Ids of the messages a send created, in the order they were requested. */
export function sentIds(result: Api.TypeUpdates, randomIds: { toString(): string }[]): number[] {
  if (result instanceof Api.UpdateShortSentMessage) return [result.id];
  const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
  const byRandomId = new Map<string, number>();
  for (const u of updates) {
    if (u instanceof Api.UpdateMessageID && u.randomId) byRandomId.set(u.randomId.toString(), u.id);
  }
  const ids = randomIds.flatMap((r) => {
    const id = byRandomId.get(r.toString());
    return id === undefined ? [] : [id];
  });
  if (ids.length > 0) return ids;
  return updates.flatMap((u) =>
    (u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage) && u.message instanceof Api.Message
      ? [u.message.id]
      : [],
  );
}

export const NOT_ANONYMOUS_ADMIN =
  'this Telegram account would post under its own name here — make it an admin of the group with ' +
  '"Remain anonymous" switched on, or choose a bot as this route\'s sender';

/** Where a send goes, and who it appears to come from. */
interface SendTarget {
  peer: Api.TypeInputPeer;
  /** The group itself, for an anonymous admin posting into a group */
  sendAs?: Api.TypeInputPeer;
  at: number;
}

const TARGET_TTL_MS = 10 * 60_000;
/** A chat joined after startup is picked up by reloading the dialog list, at most this often. */
const DIALOGS_REFRESH_MS = 60_000;

export const NOT_IN_CHAT =
  "this Telegram account isn't in that chat (or was removed) — add it there, then use “Check this account” on the route";

/** Telegram's ways of saying "this account can't reach that chat". */
const UNREACHABLE = /PEER_ID_INVALID|CHANNEL_INVALID|CHANNEL_PRIVATE|CHAT_ID_INVALID|USER_NOT_PARTICIPANT/;

/** MTProto user-account transport. Reads any channel the account is in. */
export class GramJsTransport implements Transport {
  readonly kind = 'user' as const;
  client: TelegramClient;
  private targets = new Map<string, SendTarget>();
  /** marked chat id → input peer, from the account's own dialog list */
  private dialogPeers = new Map<string, Api.TypeInputPeer>();
  private dialogsAt = 0;

  constructor(
    readonly accountId: string,
    apiId: number,
    apiHash: string,
    sessionString: string,
  ) {
    this.client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
    });
  }

  private toRelayMessage(m: GramMessage): RelayMessage {
    return {
      chatId: m.chatId?.toString() ?? '',
      messageId: m.id,
      albumKey: m.groupedId ? m.groupedId.toString() : undefined,
      date: m.date,
      media: mediaKindOf(m),
      text: { text: m.message ?? '', entities: fromApiEntities(m.entities ?? undefined) },
      hasButtons: Boolean(m.replyMarkup),
      topicId: topicIdOf(m),
    };
  }

  /**
   * The account's chats, with access hashes. Kept separately from GramJS's
   * entity cache, which never replaces an entry once stored — a stale or
   * "forbidden" copy there would otherwise stick until restart.
   */
  private async loadDialogs(): Promise<void> {
    const dialogs = await this.client.getDialogs({ limit: 500 });
    const peers = new Map<string, Api.TypeInputPeer>();
    for (const d of dialogs) {
      const entity = d.entity;
      // removed/banned chats still appear in dialogs, but can't be posted to
      if (!entity || entity instanceof Api.ChannelForbidden || entity instanceof Api.ChatForbidden) continue;
      try {
        peers.set(utils.getPeerId(entity).toString(), utils.getInputPeer(entity));
      } catch {
        // entities without a usable access hash can't be addressed
      }
    }
    this.dialogPeers = peers;
    this.dialogsAt = Date.now();
  }

  private async peer(chatId: string): Promise<Api.TypeInputPeer> {
    if (!/^-?\d+$/.test(chatId)) return this.client.getInputEntity(chatId);
    const known = this.dialogPeers.get(chatId);
    if (known) return known;
    if (Date.now() - this.dialogsAt > DIALOGS_REFRESH_MS) {
      await this.loadDialogs();
      const fresh = this.dialogPeers.get(chatId);
      if (fresh) return fresh;
    }
    throw new TransportError('not_found', NOT_IN_CHAT);
  }

  /** Drop everything cached about a chat, so the next send looks again. */
  private forget(chatId: string): void {
    this.targets.delete(chatId);
    this.dialogPeers.delete(chatId);
    this.dialogsAt = 0;
  }

  /** A send failed: make Telegram's code readable, and look the chat up afresh next time. */
  private sendFailure(chatId: string, err: unknown): TransportError {
    const mapped = mapGramError(err);
    this.targets.delete(chatId);
    if (UNREACHABLE.test(mapped.message)) {
      this.forget(chatId);
      return new TransportError('not_found', `${NOT_IN_CHAT} (${mapped.message})`);
    }
    return mapped;
  }

  /**
   * Resolve a receiver once per few minutes. In a group, a user account must
   * post as the group itself (anonymous admin): posting under the account's
   * own name would reveal it, so that is refused instead.
   */
  private async target(chatId: string): Promise<SendTarget> {
    const cached = this.targets.get(chatId);
    if (cached && Date.now() - cached.at < TARGET_TTL_MS) return cached;

    const peer = await this.peer(chatId);
    let sendAs: Api.TypeInputPeer | undefined;
    if (peer instanceof Api.InputPeerChat) throw new TransportError('forbidden', NOT_ANONYMOUS_ADMIN);
    if (peer instanceof Api.InputPeerChannel) {
      const entity = await this.client.getEntity(peer);
      if (entity instanceof Api.Channel && entity.megagroup) {
        const options = await this.client.invoke(new Api.channels.GetSendAs({ peer })).catch((err: unknown) => {
          const mapped = mapGramError(err);
          throw new TransportError(mapped.code, `checking whether this account can post as the group: ${mapped.message}`);
        });
        const asGroup = options.peers.some(
          (p) => p.peer instanceof Api.PeerChannel && p.peer.channelId.equals(peer.channelId),
        );
        if (!asGroup) throw new TransportError('forbidden', NOT_ANONYMOUS_ADMIN);
        sendAs = peer;
      }
      // broadcast channels: every post already appears as the channel
    }
    const target = { peer, sendAs, at: Date.now() };
    this.targets.set(chatId, target);
    return target;
  }

  /** The source post's media, as references Telegram can re-send without a re-upload. */
  private async sourceMedia(chatId: string, ids: number[]): Promise<Api.TypeInputMedia[]> {
    const source = await this.peer(chatId).catch(() => {
      throw new TransportError(
        'rejected',
        "this Telegram account isn't in the master channel — join it with the account so photos and files can be copied",
      );
    });
    const msgs = await this.client.getMessages(source, { ids });
    return msgs.flatMap((m) => {
      if (!m?.media || m.media instanceof Api.MessageMediaWebPage) return [];
      try {
        return [utils.getInputMedia(m.media)];
      } catch {
        throw new TransportError('rejected', `this kind of media can't be copied by a user account (${m.media.className})`);
      }
    });
  }

  async start(handlers: ReaderHandlers): Promise<void> {
    await this.client.connect();
    const authorized = await this.client.checkAuthorization();
    if (!authorized) throw new TransportError('session_revoked', 'session is not authorized');
    await this.loadDialogs().catch((err) => console.warn(`[user:${this.accountId}] could not load dialogs:`, err));

    this.client.addEventHandler((event) => {
      const msg = event.message as GramMessage;
      if (!msg?.chatId || msg.action) return;
      void handlers.onPost(this.accountId, this.toRelayMessage(msg));
    }, new NewMessage({}));

    this.client.addEventHandler((event) => {
      const msg = event.message as GramMessage;
      if (!msg?.chatId) return;
      void handlers.onEdit(this.accountId, this.toRelayMessage(msg));
    }, new EditedMessage({}));

    this.client.addEventHandler((event: { deletedIds?: number[]; chatId?: { toString(): string } }) => {
      if (!event.chatId || !event.deletedIds?.length) return;
      void handlers.onDelete(this.accountId, event.chatId.toString(), event.deletedIds);
    }, new DeletedMessage({}));
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  exportSession(): string {
    return (this.client.session as StringSession).save();
  }

  async copy(opts: SendOptions): Promise<number[]> {
    try {
      const { peer, sendAs } = await this.target(opts.toChatId);
      const replyTo = topicReply(opts.topicId);
      const medias = opts.mediaKind === 'text' ? [] : await this.sourceMedia(opts.fromChatId, opts.srcMessageIds);
      // on an album resume the caption already went out with the first item
      const caption = opts.applyCaption === false ? { text: '', entities: [] } : opts.text;

      let ids: number[];
      if (medias.length === 0) {
        const randomId = helpers.generateRandomLong();
        const res = await this.client.invoke(
          new Api.messages.SendMessage({
            peer,
            message: opts.text.text,
            entities: toApiEntities(opts.text.entities),
            silent: opts.silent,
            replyTo,
            sendAs,
            randomId,
          }),
        );
        ids = sentIds(res, [randomId]);
      } else if (medias.length === 1) {
        const randomId = helpers.generateRandomLong();
        const res = await this.client.invoke(
          new Api.messages.SendMedia({
            peer,
            media: medias[0]!,
            message: caption.text,
            entities: toApiEntities(caption.entities),
            silent: opts.silent,
            replyTo,
            sendAs,
            randomId,
          }),
        );
        ids = sentIds(res, [randomId]);
      } else {
        const randomIds = medias.map(() => helpers.generateRandomLong());
        const res = await this.client.invoke(
          new Api.messages.SendMultiMedia({
            peer,
            multiMedia: medias.map(
              (media, i) =>
                new Api.InputSingleMedia({
                  media,
                  randomId: randomIds[i]!,
                  message: i === 0 ? caption.text : '',
                  entities: i === 0 ? toApiEntities(caption.entities) : undefined,
                }),
            ),
            silent: opts.silent,
            replyTo,
            sendAs,
          }),
        );
        ids = sentIds(res, randomIds);
      }
      await opts.onSent?.(ids);
      return ids;
    } catch (err) {
      if (err instanceof TransportError) throw err;
      // rights may have changed (e.g. "Remain anonymous" switched off): look again next time
      throw this.sendFailure(opts.toChatId, err);
    }
  }

  async forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]> {
    try {
      const { peer, sendAs } = await this.target(opts.toChatId);
      const randomIds = opts.srcMessageIds.map(() => helpers.generateRandomLong());
      const res = await this.client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer: await this.peer(opts.fromChatId),
          id: opts.srcMessageIds,
          randomId: randomIds,
          toPeer: peer,
          silent: opts.silent,
          topMsgId: opts.topicId && opts.topicId !== GENERAL_TOPIC_ID ? opts.topicId : undefined,
          sendAs,
        }),
      );
      const ids = sentIds(res, randomIds);
      await opts.onSent?.(ids);
      return ids;
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw this.sendFailure(opts.toChatId, err);
    }
  }

  async editCopy(chatId: string, messageId: number, text: RichText): Promise<void> {
    try {
      await this.client.editMessage(await this.peer(chatId), {
        message: messageId,
        text: text.text,
        formattingEntities: toApiEntities(text.entities),
      });
    } catch (err) {
      const mapped = mapGramError(err);
      if (/MESSAGE_NOT_MODIFIED/.test(mapped.message)) return; // no-op edit
      throw mapped;
    }
  }

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    try {
      await this.client.deleteMessages(await this.peer(chatId), messageIds, { revoke: true });
    } catch (err) {
      throw mapGramError(err);
    }
  }

  async history(chatId: string, sinceUnixSeconds: number): Promise<RelayMessage[]> {
    try {
      const msgs = await this.client.getMessages(await this.peer(chatId), { limit: 50 });
      return msgs
        .filter((m): m is GramMessage => Boolean(m) && !m.action && m.date >= sinceUnixSeconds)
        .map((m) => this.toRelayMessage(m))
        .reverse(); // oldest first
    } catch (err) {
      throw mapGramError(err);
    }
  }

  async resolveChannel(ref: string): Promise<ResolvedChannel> {
    try {
      const trimmed = ref.trim();
      const entity = await this.client.getEntity(/^-?\d+$/.test(trimmed) ? await this.peer(trimmed) : trimmed);
      if (entity instanceof Api.Chat) {
        return {
          tgChatId: `-${entity.id.toString()}`,
          title: entity.title,
          isProtected: Boolean(entity.noforwards),
          memberCount: entity.participantsCount ?? undefined,
          chatType: 'group',
          isForum: false,
        };
      }
      if (!(entity instanceof Api.Channel)) {
        throw new TransportError('not_found', 'that is a private chat, not a channel or group');
      }
      return {
        tgChatId: `-100${entity.id.toString()}`,
        title: entity.title,
        username: entity.username ?? undefined,
        isProtected: Boolean(entity.noforwards),
        memberCount: entity.participantsCount ?? undefined,
        chatType: entity.megagroup ? 'supergroup' : 'channel',
        isForum: Boolean(entity.forum),
      };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw mapGramError(err);
    }
  }

  async checkTopic(chatId: string, topicId: number): Promise<{ title?: string }> {
    try {
      const res = await this.client.invoke(
        new Api.channels.GetForumTopicsByID({ channel: await this.peer(chatId), topics: [topicId] }),
      );
      const topic = res.topics[0];
      if (!(topic instanceof Api.ForumTopic)) {
        throw new TransportError('rejected', 'there is no topic with that link in this group — copy the link from the topic itself');
      }
      if (topic.closed) {
        throw new TransportError('rejected', 'that topic is closed — reopen it in Telegram so posts can land there');
      }
      return { title: topic.title };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      if (/TOPIC_ID_INVALID|TOPIC_DELETED/.test((err as { errorMessage?: string }).errorMessage ?? '')) {
        throw new TransportError('rejected', 'there is no topic with that link in this group — copy the link from the topic itself');
      }
      throw mapGramError(err);
    }
  }

  async checkAccess(chatId: string, topicId?: number | null): Promise<AccessCheck[]> {
    const checks: AccessCheck[] = [];
    this.forget(chatId); // a fresh look, not the cached decision

    let peer: Api.TypeInputPeer;
    try {
      peer = await this.peer(chatId);
    } catch {
      checks.push({
        label: 'The account is in this chat',
        ok: false,
        detail: "Not among the account's chats. Add the account to the group (or join the channel) with Telegram, then check again.",
      });
      return checks;
    }
    checks.push({ label: 'The account is in this chat', ok: true });

    if (peer instanceof Api.InputPeerChat) {
      checks.push({
        label: 'Group can post anonymously',
        ok: false,
        detail: 'This is a basic group. Making the account an admin with Remain Anonymous upgrades it; do that, then check again.',
      });
      return checks;
    }
    if (!(peer instanceof Api.InputPeerChannel)) {
      checks.push({ label: 'This is a group or channel', ok: false });
      return checks;
    }

    try {
      const entity = await this.client.getEntity(peer);
      const isGroup = entity instanceof Api.Channel && Boolean(entity.megagroup);

      let role: 'owner' | 'admin' | 'member' | 'restricted' | 'outside' = 'outside';
      let rights: Api.TypeChatAdminRights | undefined;
      try {
        const res = await this.client.invoke(
          new Api.channels.GetParticipant({ channel: peer, participant: new Api.InputPeerSelf() }),
        );
        const p = res.participant;
        if (p instanceof Api.ChannelParticipantCreator) [role, rights] = ['owner', p.adminRights];
        else if (p instanceof Api.ChannelParticipantAdmin) [role, rights] = ['admin', p.adminRights];
        else if (p instanceof Api.ChannelParticipantBanned) role = 'restricted';
        else if (p instanceof Api.ChannelParticipantLeft) role = 'outside';
        else role = 'member';
      } catch (err) {
        if (!/USER_NOT_PARTICIPANT/.test(mapGramError(err).message)) throw err;
      }
      const isAdmin = role === 'owner' || role === 'admin';
      const whyNotAdmin =
        role === 'member'
          ? "It's a member but not an admin. Make it an admin."
          : role === 'restricted'
            ? "It's restricted or removed in this chat."
            : "It isn't a member. Add it, then make it an admin.";

      if (!isGroup) {
        checks.push({
          label: 'Admin with Post Messages',
          ok: isAdmin && (role === 'owner' || Boolean(rights?.postMessages)),
          detail: isAdmin ? (rights?.postMessages || role === 'owner' ? undefined : 'Turn on Post Messages for it.') : whyNotAdmin,
        });
        return checks;
      }

      checks.push({ label: 'Admin in the group', ok: isAdmin, detail: isAdmin ? undefined : whyNotAdmin });
      if (!isAdmin) return checks;
      checks.push({
        label: 'Remain Anonymous is on',
        ok: Boolean(rights?.anonymous),
        detail: rights?.anonymous
          ? undefined
          : "Edit this account's admin rights in the group and switch on Remain Anonymous.",
      });

      const options = await this.client.invoke(new Api.channels.GetSendAs({ peer }));
      const asGroup = options.peers.some(
        (o) => o.peer instanceof Api.PeerChannel && o.peer.channelId.equals(peer.channelId),
      );
      checks.push({
        label: 'Posts will appear as the group',
        ok: asGroup,
        detail: asGroup ? undefined : 'Telegram does not offer the group as a sender for this account yet.',
      });

      if (topicId && topicId !== GENERAL_TOPIC_ID && entity instanceof Api.Channel && entity.forum) {
        try {
          const found = await this.checkTopic(chatId, topicId);
          checks.push({ label: 'The topic exists', ok: true, detail: found.title });
        } catch (err) {
          checks.push({ label: 'The topic exists', ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      checks.push({ label: 'Telegram answered the check', ok: false, detail: mapGramError(err).message });
    }
    return checks;
  }

  async joinChannel(ref: string): Promise<ResolvedChannel> {
    try {
      const inviteHash = /(?:t(?:elegram)?\.me\/(?:\+|joinchat\/))([\w-]+)/.exec(ref)?.[1];
      if (inviteHash) {
        await this.client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
        // after joining, the dialog is known — resolve via the most recent dialog
        const dialogs = await this.client.getDialogs({ limit: 5 });
        const joined = dialogs[0]?.entity;
        if (joined instanceof Api.Channel) {
          return {
            tgChatId: `-100${joined.id.toString()}`,
            title: joined.title,
            username: joined.username ?? undefined,
            isProtected: Boolean(joined.noforwards),
            chatType: joined.megagroup ? 'supergroup' : 'channel',
            isForum: Boolean(joined.forum),
          };
        }
        throw new TransportError('unknown', 'joined but could not resolve the channel');
      }
      const resolved = await this.resolveChannel(ref);
      await this.client.invoke(
        new Api.channels.JoinChannel({ channel: await this.client.getEntity(ref) }),
      );
      return resolved;
    } catch (err) {
      if (err instanceof TransportError) throw err;
      const mapped = mapGramError(err);
      if (/USER_ALREADY_PARTICIPANT/.test(mapped.message)) return this.resolveChannel(ref);
      throw mapped;
    }
  }

  /** Plain-text delivery used by the alert dispatcher. */
  async sendPlain(target: string, text: string): Promise<void> {
    try {
      await this.client.sendMessage(/^-?\d+$/.test(target) ? await this.peer(target) : target, { message: text });
    } catch (err) {
      throw mapGramError(err);
    }
  }
}
