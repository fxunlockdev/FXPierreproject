import { Api, TelegramClient, errors } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { EditedMessage } from 'telegram/events/EditedMessage.js';
import { DeletedMessage } from 'telegram/events/DeletedMessage.js';
import type { Entity, MediaKind, RelayMessage, RichText } from '@pierre/core';
import {
  TransportError,
  type ReaderHandlers,
  type ResolvedChannel,
  type SendOptions,
  type Transport,
} from './transport.js';

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

/** MTProto user-account transport. Reads any channel the account is in. */
export class GramJsTransport implements Transport {
  readonly kind = 'user' as const;
  client: TelegramClient;

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
    };
  }

  async start(handlers: ReaderHandlers): Promise<void> {
    await this.client.connect();
    const authorized = await this.client.checkAuthorization();
    if (!authorized) throw new TransportError('session_revoked', 'session is not authorized');

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
      const entities = toApiEntities(opts.text.entities);

      if (opts.mediaKind === 'text') {
        const res = await this.client.sendMessage(opts.toChatId, {
          message: opts.text.text,
          formattingEntities: entities,
          silent: opts.silent,
        });
        return [res.id];
      }

      const src = await this.client.getMessages(opts.fromChatId, { ids: opts.srcMessageIds });
      const medias = src
        .filter((m): m is GramMessage => Boolean(m))
        .map((m) => m.media)
        .filter(
          (m): m is Api.TypeMessageMedia => Boolean(m) && !(m instanceof Api.MessageMediaWebPage),
        );

      if (medias.length === 0) {
        const res = await this.client.sendMessage(opts.toChatId, {
          message: opts.text.text,
          formattingEntities: entities,
          silent: opts.silent,
        });
        return [res.id];
      }

      const res = await this.client.sendFile(opts.toChatId, {
        file: medias.length === 1 ? medias[0]! : medias,
        caption: opts.text.text,
        formattingEntities: entities,
        silent: opts.silent,
      });
      return Array.isArray(res) ? res.map((m) => m.id) : [res.id];
    } catch (err) {
      throw mapGramError(err);
    }
  }

  async forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]> {
    try {
      const res = await this.client.forwardMessages(opts.toChatId, {
        messages: opts.srcMessageIds,
        fromPeer: opts.fromChatId,
        silent: opts.silent,
      });
      return res.map((m) => m.id);
    } catch (err) {
      throw mapGramError(err);
    }
  }

  async editCopy(chatId: string, messageId: number, text: RichText): Promise<void> {
    try {
      await this.client.editMessage(chatId, {
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
      await this.client.deleteMessages(chatId, messageIds, { revoke: true });
    } catch (err) {
      throw mapGramError(err);
    }
  }

  async history(chatId: string, sinceUnixSeconds: number): Promise<RelayMessage[]> {
    try {
      const msgs = await this.client.getMessages(chatId, { limit: 50 });
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
      const entity = await this.client.getEntity(ref);
      if (!(entity instanceof Api.Channel)) {
        throw new TransportError('not_found', 'reference is not a channel');
      }
      return {
        tgChatId: `-100${entity.id.toString()}`,
        title: entity.title,
        username: entity.username ?? undefined,
        isProtected: Boolean(entity.noforwards),
        memberCount: entity.participantsCount ?? undefined,
      };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw mapGramError(err);
    }
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
      await this.client.sendMessage(target, { message: text });
    } catch (err) {
      throw mapGramError(err);
    }
  }
}
