import { Bot, GrammyError, HttpError } from 'grammy';
import type { ChatMember, Message } from 'grammy/types';
import type { Entity, MediaKind, RelayMessage, RichText } from '@pierre/core';
import {
  GENERAL_TOPIC_ID,
  TransportError,
  type AlbumItem,
  type ChatType,
  type DiscoveredChat,
  type ReaderHandlers,
  type ResolvedChannel,
  type SendOptions,
  type Transport,
} from './transport';

type BotEntity = NonNullable<Message['entities']>[number];

const TO_BOT_TYPE: Partial<Record<Entity['type'], string>> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strikethrough',
  spoiler: 'spoiler',
  code: 'code',
  pre: 'pre',
  text_link: 'text_link',
  url: 'url',
  mention: 'mention',
  hashtag: 'hashtag',
  cashtag: 'cashtag',
  bot_command: 'bot_command',
  email: 'email',
  phone: 'phone_number',
  blockquote: 'blockquote',
};

export function toBotEntities(entities: Entity[]): BotEntity[] {
  const out: BotEntity[] = [];
  for (const e of entities) {
    const type = TO_BOT_TYPE[e.type];
    if (!type) continue; // custom_emoji cannot be re-sent without its id
    const entity: Record<string, unknown> = { type, offset: e.offset, length: e.length };
    if (e.type === 'text_link') entity['url'] = e.url;
    if (e.type === 'pre' && e.language) entity['language'] = e.language;
    out.push(entity as unknown as BotEntity);
  }
  return out;
}

export function fromBotEntities(entities: BotEntity[] | undefined): Entity[] {
  if (!entities) return [];
  const out: Entity[] = [];
  for (const e of entities) {
    const base = { offset: e.offset, length: e.length };
    switch (e.type) {
      case 'phone_number': out.push({ ...base, type: 'phone' }); break;
      case 'text_link': out.push({ ...base, type: 'text_link', url: e.url }); break;
      case 'pre': out.push({ ...base, type: 'pre', language: e.language }); break;
      case 'bold': case 'italic': case 'underline': case 'strikethrough': case 'spoiler':
      case 'code': case 'url': case 'mention': case 'hashtag': case 'cashtag':
      case 'bot_command': case 'email': case 'blockquote':
        out.push({ ...base, type: e.type });
        break;
      default: break;
    }
  }
  return out;
}

function mediaKindOf(m: Message): MediaKind {
  if (m.photo) return 'photo';
  if (m.animation) return 'animation';
  if (m.video) return 'video';
  if (m.voice) return 'voice';
  if (m.audio) return 'audio';
  if (m.sticker) return 'sticker';
  if (m.poll) return 'poll';
  if (m.document) return 'document';
  if (m.text !== undefined) return 'text';
  return 'other';
}

/**
 * Telegram error → what the engine should do about it. The distinction that
 * matters most: a problem with the RECEIVER (pause the route, raise an
 * incident) vs. a problem with THIS MESSAGE (fail it, keep relaying the rest).
 */
export function mapBotError(err: unknown): TransportError {
  if (err instanceof GrammyError) {
    const d = err.description;
    if (err.error_code === 429) {
      const retryAfter = (err.parameters?.retry_after as number | undefined) ?? 30;
      return new TransportError('flood_wait', d, retryAfter);
    }
    if (err.error_code === 401) return new TransportError('session_revoked', d);
    if (err.error_code === 403) return new TransportError('forbidden', d);
    if (/protected content|forwards? (is |are )?restricted/i.test(d)) {
      return new TransportError('protected', d);
    }
    if (/not enough rights|administrator rights|have no rights|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN/i.test(d)) {
      return new TransportError('forbidden', d);
    }
    // the source post was deleted before we copied it — not the receiver's fault
    if (/message to (copy|forward|edit|delete) not found|MESSAGE_ID_INVALID/i.test(d)) {
      return new TransportError('rejected', d);
    }
    if (/chat not found|PEER_ID_INVALID|CHANNEL_INVALID|group chat was upgraded/i.test(d)) {
      return new TransportError('not_found', d);
    }
    // any other 400 is about this message's content; retrying can't fix it
    if (err.error_code === 400) return new TransportError('rejected', d);
    return new TransportError('unknown', d);
  }
  if (err instanceof HttpError) return new TransportError('network', String(err));
  return new TransportError('unknown', err instanceof Error ? err.message : String(err));
}

/** Media Telegram lets you attach a caption to. */
const CAPTIONABLE = new Set<string>(['photo', 'video', 'animation', 'audio', 'document', 'voice']);
/** Media that can be sent as one grouped album. */
const GROUPABLE = new Set<string>(['photo', 'video', 'document', 'audio']);

function fileIdOf(m: Message): string | undefined {
  if (m.photo?.length) return m.photo[m.photo.length - 1]!.file_id; // largest size
  return (m.animation ?? m.video ?? m.document ?? m.audio ?? m.voice ?? m.sticker ?? m.video_note)
    ?.file_id;
}

const isForumChat = (chat: unknown): boolean =>
  Boolean((chat as { is_forum?: boolean } | undefined)?.is_forum);

/**
 * Forum topic of a message: its thread for topic messages, General (1) for
 * the rest of a forum. Reply threads in non-forum groups are NOT topics.
 */
function topicIdOf(m: Message): number | undefined {
  if (!isForumChat(m.chat)) return undefined;
  return m.is_topic_message && m.message_thread_id ? m.message_thread_id : GENERAL_TOPIC_ID;
}

/** Name of the topic, when this message carries it (Telegram doesn't always). */
function topicTitleOf(m: Message, topicId: number): string {
  if (topicId === GENERAL_TOPIC_ID) return 'General';
  return (
    m.forum_topic_created?.name ??
    m.forum_topic_edited?.name ??
    m.reply_to_message?.forum_topic_created?.name ??
    ''
  );
}

/** Thread parameter for sends: General needs none. */
const threadParam = (topicId: number | null | undefined) =>
  topicId && topicId !== GENERAL_TOPIC_ID ? { message_thread_id: topicId } : {};

/** Normalize a Bot API message into the relay's message model. */
export function toRelayMessage(m: Message): RelayMessage {
  return {
    topicId: topicIdOf(m),
    chatId: String(m.chat.id),
    messageId: m.message_id,
    albumKey: m.media_group_id,
    date: m.date,
    media: mediaKindOf(m),
    text: {
      text: m.text ?? m.caption ?? '',
      entities: fromBotEntities(m.entities ?? m.caption_entities),
    },
    hasButtons: Boolean(m.reply_markup),
    fileId: fileIdOf(m),
    hasSpoiler: m.has_media_spoiler || undefined,
  };
}

const ALLOWED_UPDATES = [
  'channel_post',
  'edited_channel_post',
  'message',
  'edited_message',
  'my_chat_member',
] as const;

/** Joins, pins, title changes, group upgrades… — never relayed. */
const SERVICE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'pinned_message', 'migrate_to_chat_id', 'migrate_from_chat_id',
  'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started',
  'video_chat_ended', 'video_chat_participants_invited', 'forum_topic_created',
  'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened',
  'general_forum_topic_hidden', 'general_forum_topic_unhidden', 'write_access_allowed',
  'boost_added', 'chat_background_set', 'giveaway_created', 'giveaway_completed',
  'proximity_alert_triggered', 'users_shared', 'chat_shared', 'connected_website',
] as const;

const isServiceMessage = (m: Message): boolean => SERVICE_FIELDS.some((field) => field in m);

const chatTypeOf = (type: string): ChatType | null =>
  type === 'channel' || type === 'supergroup' || type === 'group' ? type : null;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Bot API transport: fast sender, and a reader for channels where the bot is
 * admin and groups where it is admin (or where group privacy mode is off).
 */
export class BotApiTransport implements Transport {
  readonly kind = 'bot' as const;
  bot: Bot;
  username = '';
  tgId = '';
  private runner: Promise<void> | null = null;
  private stopped = false;
  /** Group privacy mode off (BotFather /setprivacy) → reads groups without admin. */
  private readsAllGroupMessages = false;
  /** Chats already reported to discovery this process lifetime. */
  private knownChats = new Set<string>();
  /** Forum topics already reported this process lifetime (chat:topic). */
  private knownTopics = new Set<string>();

  constructor(
    readonly accountId: string,
    token: string,
  ) {
    this.bot = new Bot(token);
  }

  /** Reduce a chat + the bot's membership in it to what the dashboard needs. */
  private toDiscovered(
    chatType: ChatType,
    chat: { id: number; title?: string; username?: string; is_forum?: boolean },
    member: ChatMember,
  ): DiscoveredChat {
    const status = member.status === 'creator' ? 'administrator' : member.status;
    const isAdmin = status === 'administrator';
    const present = isAdmin || status === 'member' || status === 'restricted';

    const canPost =
      chatType === 'channel'
        ? member.status === 'administrator' && Boolean(member.can_post_messages)
        : member.status === 'restricted'
          ? member.can_send_messages
          : present;
    const canRead = chatType === 'channel' ? isAdmin : isAdmin || (present && this.readsAllGroupMessages);

    return {
      tgChatId: String(chat.id),
      chatType,
      title: chat.title ?? '',
      username: chat.username,
      status,
      canRead,
      canPost,
      isForum: Boolean(chat.is_forum),
    };
  }

  /** Report a forum topic the first time we see it, and whenever its name shows up. */
  private noteTopic(handlers: ReaderHandlers, m: Message, topicId: number): void {
    if (!handlers.onTopicSeen) return;
    const key = `${m.chat.id}:${topicId}`;
    const title = topicTitleOf(m, topicId);
    if (this.knownTopics.has(key) && !title) return;
    this.knownTopics.add(key);
    void Promise.resolve(handlers.onTopicSeen(this.accountId, String(m.chat.id), topicId, title)).catch((err) =>
      console.warn(`[bot:${this.username}] could not record topic ${key}: ${errorText(err)}`),
    );
  }

  /** First message from a chat we haven't catalogued: look up our rights there. */
  private noteChat(handlers: ReaderHandlers, chatId: number): void {
    const key = String(chatId);
    if (!handlers.onChatSeen || this.knownChats.has(key)) return;
    this.knownChats.add(key);
    void Promise.all([this.bot.api.getChat(chatId), this.bot.api.getChatMember(chatId, this.bot.botInfo.id)])
      .then(([chat, member]) => {
        const chatType = chatTypeOf(chat.type);
        if (!chatType) return;
        return handlers.onChatSeen?.(
          this.accountId,
          this.toDiscovered(chatType, chat as { id: number; title?: string; username?: string; is_forum?: boolean }, member),
          false,
        );
      })
      .catch((err) => {
        this.knownChats.delete(key); // try again on the next message
        console.warn(`[bot:${this.username}] could not describe chat ${key}: ${errorText(err)}`);
      });
  }

  async start(handlers: ReaderHandlers): Promise<void> {
    await this.bot.init();
    this.username = this.bot.botInfo.username;
    this.tgId = String(this.bot.botInfo.id);
    this.readsAllGroupMessages = Boolean(this.bot.botInfo.can_read_all_group_messages);

    const onMessage = (m: Message, kind: 'post' | 'edit'): void => {
      if (m.migrate_to_chat_id) {
        void handlers.onChatMigrated?.(String(m.chat.id), String(m.migrate_to_chat_id));
        return;
      }
      if (!chatTypeOf(m.chat.type)) return; // private chats with the bot are not relay traffic
      this.noteChat(handlers, m.chat.id);
      const relay = toRelayMessage(m);
      // topic created/renamed service messages are how topic names are learned
      if (relay.topicId !== undefined) this.noteTopic(handlers, m, relay.topicId);
      // service messages, and a channel's automatic copy into its linked
      // discussion group (the channel post itself is the source of truth)
      if (isServiceMessage(m) || m.is_automatic_forward) return;

      if (kind === 'post') void handlers.onPost(this.accountId, relay);
      else void handlers.onEdit(this.accountId, relay);
    };

    this.bot.on('channel_post', (ctx) => onMessage(ctx.channelPost, 'post'));
    this.bot.on('edited_channel_post', (ctx) => onMessage(ctx.editedChannelPost, 'edit'));
    this.bot.on('message', (ctx) => onMessage(ctx.message, 'post'));
    this.bot.on('edited_message', (ctx) => onMessage(ctx.editedMessage, 'edit'));
    this.bot.on('my_chat_member', (ctx) => {
      const update = ctx.myChatMember;
      const chatType = chatTypeOf(update.chat.type);
      if (!chatType) return;
      this.knownChats.add(String(update.chat.id));
      void handlers.onChatSeen?.(
        this.accountId,
        this.toDiscovered(
          chatType,
          update.chat as { id: number; title?: string; username?: string; is_forum?: boolean },
          update.new_chat_member,
        ),
        true,
      );
    });

    // grammY stops polling on the first unhandled middleware error — a relay
    // must never go deaf because one update was malformed
    this.bot.catch((err) => {
      console.error(`[bot:${this.username}] update handling failed: ${errorText(err.error)}`);
    });

    this.stopped = false;
    this.runner = this.pollForever();
  }

  /** Long-poll until stop(); restarts after errors instead of dying silently. */
  private async pollForever(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
        return; // resolves only after stop()
      } catch (err) {
        if (this.stopped) return;
        const reason =
          err instanceof GrammyError && err.error_code === 409
            ? 'another process is polling this bot (409) — run exactly ONE worker per bot'
            : errorText(err);
        console.error(`[bot:${this.username}] polling stopped: ${reason}; retrying in 5s`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.bot.stop();
    await this.runner?.catch(() => {});
  }

  /**
   * Copy a post as a fresh message (no "Forwarded from"). Everything is sent
   * by Telegram-side reference — no download or re-upload — so large files,
   * PDFs and videos cost the same as text.
   * - text                 → sendMessage with the transformed text
   * - album (photo/video/document/audio) → ONE sendMediaGroup, grouping kept
   * - any other single post → copyMessage; caption only where Telegram allows
   */
  async copy(opts: SendOptions): Promise<number[]> {
    try {
      const chatId = Number(opts.toChatId);
      const common = { disable_notification: opts.silent, ...threadParam(opts.topicId) };

      if (opts.mediaKind === 'text' && opts.srcMessageIds.length === 1) {
        const res = await this.bot.api.sendMessage(chatId, opts.text.text, {
          ...common,
          entities: toBotEntities(opts.text.entities) as never,
          link_preview_options: { is_disabled: false },
        });
        return [res.message_id];
      }

      const album = opts.items;
      const isAlbum = Boolean(album && album.length >= 2 && album.length === opts.srcMessageIds.length);
      if (
        isAlbum &&
        album!.every(
          (item) =>
            item.fileId &&
            GROUPABLE.has(item.media) &&
            // file ids belong to the bot that received them
            (item.fileAccountId === undefined || item.fileAccountId === this.accountId),
        )
      ) {
        return await this.sendAlbum(chatId, album!, opts);
      }
      if (isAlbum) {
        // another bot read this album: copy it by message reference instead
        return await this.copyAlbum(chatId, opts);
      }

      // Single posts, and the rare album we can't regroup: item by item.
      const fromChatId = Number(opts.fromChatId);
      const ids: number[] = [];
      for (const [i, srcId] of opts.srcMessageIds.entries()) {
        const kind = album?.[i]?.media ?? opts.mediaKind;
        const withCaption = i === 0 && (opts.applyCaption ?? true) && CAPTIONABLE.has(kind);

        if (withCaption && opts.text.text.length === 0) {
          // the route's rules emptied the caption — make sure the original
          // doesn't leak through (copyMessage keeps it when none is given)
          const [res] = await this.bot.api.copyMessages(chatId, fromChatId, [srcId], {
            ...common,
            remove_caption: true,
          });
          ids.push(res!.message_id);
        } else {
          const res = await this.bot.api.copyMessage(chatId, fromChatId, srcId, {
            ...common,
            ...(withCaption
              ? {
                  caption: opts.text.text,
                  caption_entities: toBotEntities(opts.text.entities) as never,
                }
              : {}),
          });
          ids.push(res.message_id);
        }
        await opts.onSent?.(ids.slice());
      }
      return ids;
    } catch (err) {
      throw mapBotError(err);
    }
  }

  /** Re-send an album as one grouped message, transformed caption on item 1. */
  private async sendAlbum(chatId: number, album: AlbumItem[], opts: SendOptions): Promise<number[]> {
    const withCaption = (opts.applyCaption ?? true) && opts.text.text.length > 0;
    const media = album.map((item, i) => ({
      type: item.media,
      media: item.fileId!,
      ...(item.hasSpoiler && (item.media === 'photo' || item.media === 'video')
        ? { has_spoiler: true }
        : {}),
      ...(i === 0 && withCaption
        ? {
            caption: opts.text.text,
            caption_entities: toBotEntities(opts.text.entities),
          }
        : {}),
    }));
    const sent = await this.bot.api.sendMediaGroup(chatId, media as never, {
      disable_notification: opts.silent,
      ...threadParam(opts.topicId),
    });
    const ids = sent.map((m) => m.message_id);
    await opts.onSent?.(ids.slice());
    return ids;
  }

  /**
   * Album we hold no file ids for: copyMessages keeps it grouped. The original
   * caption is stripped in the same call and the transformed one set right
   * after, so the source caption is never visible in the receiver.
   */
  private async copyAlbum(chatId: number, opts: SendOptions): Promise<number[]> {
    const sent = await this.bot.api.copyMessages(chatId, Number(opts.fromChatId), opts.srcMessageIds, {
      disable_notification: opts.silent,
      remove_caption: true,
      ...threadParam(opts.topicId),
    });
    const ids = sent.map((m) => m.message_id);
    await opts.onSent?.(ids.slice());

    const caption = (opts.applyCaption ?? true) ? opts.text : null;
    if (caption && caption.text.length > 0 && ids[0] !== undefined) {
      try {
        await this.bot.api.editMessageCaption(chatId, ids[0], {
          caption: caption.text,
          caption_entities: toBotEntities(caption.entities) as never,
        });
      } catch (err) {
        // the album is already out — failing here would re-send it
        console.warn(`[bot:${this.username}] album delivered, caption not applied: ${errorText(err)}`);
      }
    }
    return ids;
  }

  /** Native forward ("Forwarded from" kept); albums stay grouped. */
  async forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]> {
    try {
      const toChatId = Number(opts.toChatId);
      const fromChatId = Number(opts.fromChatId);
      if (opts.srcMessageIds.length > 1) {
        const sent = await this.bot.api.forwardMessages(toChatId, fromChatId, opts.srcMessageIds, {
          disable_notification: opts.silent,
          ...threadParam(opts.topicId),
        });
        const ids = sent.map((m) => m.message_id);
        await opts.onSent?.(ids.slice());
        return ids;
      }
      const res = await this.bot.api.forwardMessage(toChatId, fromChatId, opts.srcMessageIds[0]!, {
        disable_notification: opts.silent,
        ...threadParam(opts.topicId),
      });
      await opts.onSent?.([res.message_id]);
      return [res.message_id];
    } catch (err) {
      throw mapBotError(err);
    }
  }

  async editCopy(chatId: string, messageId: number, text: RichText, mediaKind: string): Promise<void> {
    try {
      if (mediaKind === 'text') {
        await this.bot.api.editMessageText(Number(chatId), messageId, text.text, {
          entities: toBotEntities(text.entities) as never,
        });
      } else {
        await this.bot.api.editMessageCaption(Number(chatId), messageId, {
          caption: text.text,
          caption_entities: toBotEntities(text.entities) as never,
        });
      }
    } catch (err) {
      const mapped = mapBotError(err);
      if (/message is not modified/i.test(mapped.message)) return;
      throw mapped;
    }
  }

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    try {
      // one call for a whole album; ids already gone are skipped by Telegram
      await this.bot.api.deleteMessages(Number(chatId), messageIds);
    } catch (err) {
      throw mapBotError(err);
    }
  }

  async history(): Promise<RelayMessage[]> {
    return []; // Bot API offers no history — catch-up needs a user account
  }

  /**
   * Accepts: -100… / -… chat ids · @username · bare username ·
   * t.me/username · t.me/c/<id>/<post> (a private channel/group post link).
   * Invite links (t.me/+…) are rejected: the Bot API cannot resolve them.
   */
  static normalizeRef(ref: string): string | number {
    const trimmed = ref.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);

    const privatePost = /^(?:https?:\/\/)?(?:www\.)?t\.me\/c\/(\d+)(?:\/\d+){0,2}\/?$/i.exec(trimmed);
    if (privatePost) return Number(`-100${privatePost[1]}`);

    const url = /^(?:https?:\/\/)?(?:www\.)?t\.me\/([^?#]+?)\/?(?:[?#].*)?$/i.exec(trimmed);
    const segments = (url?.[1] ?? trimmed).split('/');
    // t.me/s/<name> is the public web preview of a channel
    const path = (segments[0] === 's' && segments[1] ? segments[1] : segments[0])!;
    if (path.startsWith('+') || path.toLowerCase() === 'joinchat') {
      throw new TransportError(
        'forbidden',
        'bots cannot open invite links — pick the chat from "Chats the bot can see", ' +
          'or paste a post link from it (… → Copy post link, looks like t.me/c/…)',
      );
    }
    return path.startsWith('@') ? path : `@${path}`;
  }

  async resolveChannel(ref: string): Promise<ResolvedChannel> {
    try {
      const chat = await this.bot.api.getChat(BotApiTransport.normalizeRef(ref));
      const chatType = chatTypeOf(chat.type);
      if (!chatType) {
        throw new TransportError('not_found', 'that is a private chat, not a channel or group');
      }
      return {
        tgChatId: String(chat.id),
        title: chat.title ?? '',
        username: chat.username,
        isProtected: Boolean(chat.has_protected_content),
        chatType,
        isForum: isForumChat(chat),
      };
    } catch (err) {
      if (err instanceof TransportError) throw err;
      throw mapBotError(err);
    }
  }

  async joinChannel(): Promise<ResolvedChannel> {
    throw new TransportError(
      'forbidden',
      'bots cannot join channels — add the bot as an admin from the Telegram app',
    );
  }

  /** Plain-text delivery used by the alert dispatcher. */
  async sendPlain(target: string, text: string): Promise<void> {
    try {
      const chatId = /^-?\d+$/.test(target) ? Number(target) : target;
      await this.bot.api.sendMessage(chatId, text);
    } catch (err) {
      throw mapBotError(err);
    }
  }
}
