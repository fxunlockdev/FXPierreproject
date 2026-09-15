import type { MediaKind, RelayMessage, RichText } from '@pierre/core';
import { richText } from '@pierre/core';
import {
  TransportError,
  type ReaderHandlers,
  type ResolvedChannel,
  type SendOptions,
  type Transport,
  type TransportErrorCode,
} from './transport.js';

export interface SentRecord {
  toChatId: string;
  fromChatId: string;
  srcMessageIds: number[];
  destMessageIds: number[];
  text: RichText;
  silent: boolean;
  removeButtons: boolean;
  native: boolean; // true = forward(), false = copy()
}

/**
 * In-memory Telegram stand-in. Drives unit tests and the SIMULATE=1 demo mode
 * so the entire product can be exercised without real credentials.
 */
export class SimTransport implements Transport {
  readonly kind = 'sim' as const;
  sent: SentRecord[] = [];
  edits: { chatId: string; messageId: number; text: RichText }[] = [];
  deletions: { chatId: string; messageIds: number[] }[] = [];
  /** toChatId → error to throw on send */
  failures = new Map<string, { code: TransportErrorCode; retryAfterSeconds?: number; times?: number }>();
  historyByChat = new Map<string, RelayMessage[]>();

  private handlers: ReaderHandlers | null = null;
  private nextDestId = 1000;
  private nextSrcId = 1;

  constructor(readonly accountId: string = 'sim-account') {}

  async start(handlers: ReaderHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = null;
  }

  /** Test/demo helper: a master channel "posts" a message. */
  async injectPost(
    chatId: string,
    text: string,
    opts: { media?: MediaKind; albumKey?: string; messageId?: number; entities?: RichText['entities'] } = {},
  ): Promise<RelayMessage> {
    const msg: RelayMessage = {
      chatId,
      messageId: opts.messageId ?? this.nextSrcId++,
      albumKey: opts.albumKey,
      date: Math.floor(Date.now() / 1000),
      media: opts.media ?? 'text',
      text: richText(text, opts.entities ?? []),
    };
    await this.handlers?.onPost(this.accountId, msg);
    return msg;
  }

  async injectEdit(
    chatId: string,
    messageId: number,
    text: string,
    media: MediaKind = 'text',
  ): Promise<void> {
    await this.handlers?.onEdit(this.accountId, {
      chatId,
      messageId,
      date: Math.floor(Date.now() / 1000),
      media,
      text: richText(text),
    });
  }

  async injectDelete(chatId: string, messageIds: number[]): Promise<void> {
    await this.handlers?.onDelete(this.accountId, chatId, messageIds);
  }

  private maybeFail(toChatId: string): void {
    const failure = this.failures.get(toChatId);
    if (!failure) return;
    if (failure.times !== undefined) {
      if (failure.times <= 0) {
        this.failures.delete(toChatId);
        return;
      }
      failure.times -= 1;
    }
    throw new TransportError(failure.code, `sim failure: ${failure.code}`, failure.retryAfterSeconds ?? 0);
  }

  async copy(opts: SendOptions): Promise<number[]> {
    this.maybeFail(opts.toChatId);
    const destMessageIds = opts.srcMessageIds.map(() => this.nextDestId++);
    this.sent.push({ ...opts, destMessageIds, native: false });
    return destMessageIds;
  }

  async forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]> {
    this.maybeFail(opts.toChatId);
    const destMessageIds = opts.srcMessageIds.map(() => this.nextDestId++);
    this.sent.push({
      ...opts,
      text: richText(''),
      removeButtons: false,
      destMessageIds,
      native: true,
    });
    return destMessageIds;
  }

  async editCopy(chatId: string, messageId: number, text: RichText): Promise<void> {
    this.maybeFail(chatId);
    this.edits.push({ chatId, messageId, text });
  }

  async deleteMessages(chatId: string, messageIds: number[]): Promise<void> {
    this.maybeFail(chatId);
    this.deletions.push({ chatId, messageIds });
  }

  async history(chatId: string, sinceUnixSeconds: number): Promise<RelayMessage[]> {
    return (this.historyByChat.get(chatId) ?? []).filter((m) => m.date >= sinceUnixSeconds);
  }

  async resolveChannel(ref: string): Promise<ResolvedChannel> {
    return {
      tgChatId: `-100${Math.abs(hash(ref)) % 10_000_000}`,
      title: `Sim ${ref.replace(/^@/, '')}`,
      username: ref.startsWith('@') ? ref.slice(1) : undefined,
      isProtected: ref.includes('protected'),
      memberCount: 1234,
    };
  }

  async joinChannel(ref: string): Promise<ResolvedChannel> {
    return this.resolveChannel(ref);
  }
}

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};
