import { Bot, GrammyError, HttpError } from 'grammy';
import type { Message } from 'grammy/types';
import type { Entity, MediaKind, RelayMessage, RichText } from '@pierre/core';
import {
  TransportError,
  type ReaderHandlers,
  type ResolvedChannel,
  type SendOptions,
  type Transport,
} from './transport.js';

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

export function mapBotError(err: unknown): TransportError {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) {
      const retryAfter = (err.parameters?.retry_after as number | undefined) ?? 30;
      return new TransportError('flood_wait', err.description, retryAfter);
    }
    if (err.error_code === 403) return new TransportError('forbidden', err.description);
    if (err.error_code === 401) return new TransportError('session_revoked', err.description);
    if (/not found|not_found|chat not found|message to copy not found/i.test(err.description)) {
      return new TransportError('not_found', err.description);
    }
    return new TransportError('unknown', err.description);
  }
  if (err instanceof HttpError) return new TransportError('network', String(err));
  return new TransportError('unknown', err instanceof Error ? err.message : String(err));
}

/** Bot API transport: fast sender; reads only channels where the bot is admin. */
export class BotApiTransport implements Transport {
  readonly kind = 'bot' as const;
  bot: Bot;
  username = '';
  tgId = '';
  private runner: Promise<void> | null = null;

  constructor(
    readonly accountId: string,
    token: string,
  ) {
    this.bot = new Bot(token);
  }

  private toRelayMessage(m: Message): RelayMessage {
    return {
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
    };
  }

  async start(handlers: ReaderHandlers): Promise<void> {
    await this.bot.init();
    this.username = this.bot.botInfo.username;
    this.tgId = String(this.bot.botInfo.id);

    this.bot.on('channel_post', (ctx) => {
      void handlers.onPost(this.accountId, this.toRelayMessage(ctx.msg));
    });
    this.bot.on('edited_channel_post', (ctx) => {
      void handlers.onEdit(this.accountId, this.toRelayMessage(ctx.msg));
    });

    this.runner = this.bot
      .start({ allowed_updates: ['channel_post', 'edited_channel_post'] })
      .catch((err) => console.error(`[bot:${this.username}] polling stopped:`, err));
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await this.runner?.catch(() => {});
  }

  async copy(opts: SendOptions): Promise<number[]> {
    try {
      const chatId = Number(opts.toChatId);
      if (opts.mediaKind === 'text') {
        const res = await this.bot.api.sendMessage(chatId, opts.text.text, {
          entities: toBotEntities(opts.text.entities) as never,
          disable_notification: opts.silent,
          link_preview_options: { is_disabled: false },
        });
        return [res.message_id];
      }

      const fromChatId = Number(opts.fromChatId);
      const ids: number[] = [];
      for (const [i, srcId] of opts.srcMessageIds.entries()) {
        const res = await this.bot.api.copyMessage(chatId, fromChatId, srcId, {
          disable_notification: opts.silent,
          ...(i === 0
            ? {
                caption: opts.text.text,
                caption_entities: toBotEntities(opts.text.entities) as never,
              }
            : {}),
        });
        ids.push(res.message_id);
      }
      return ids;
    } catch (err) {
      throw mapBotError(err);
    }
  }

  async forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]> {
    try {
      const ids: number[] = [];
      for (const srcId of opts.srcMessageIds) {
        const res = await this.bot.api.forwardMessage(
          Number(opts.toChatId),
          Number(opts.fromChatId),
          srcId,
          { disable_notification: opts.silent },
        );
        ids.push(res.message_id);
      }
      return ids;
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
    try {
      for (const id of messageIds) {
        await this.bot.api.deleteMessage(Number(chatId), id);
      }
    } catch (err) {
      throw mapBotError(err);
    }
  }

  async history(): Promise<RelayMessage[]> {
    return []; // Bot API offers no history — catch-up needs a user account
  }

  async resolveChannel(ref: string): Promise<ResolvedChannel> {
    try {
      const chat = await this.bot.api.getChat(/^-?\d+$/.test(ref) ? Number(ref) : ref);
      if (chat.type !== 'channel' && chat.type !== 'supergroup') {
        throw new TransportError('not_found', 'reference is not a channel');
      }
      return {
        tgChatId: String(chat.id),
        title: chat.title ?? '',
        username: chat.username,
        isProtected: Boolean(chat.has_protected_content),
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
