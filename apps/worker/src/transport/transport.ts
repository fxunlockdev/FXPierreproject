import type { RelayMessage, RichText } from '@pierre/core';

/** Normalized failure classes the sender knows how to react to. */
export type TransportErrorCode =
  | 'flood_wait' // retry after `retryAfterSeconds`
  | 'forbidden' // no permission to post/edit in the target
  | 'protected' // source restricts forwarding/copying
  | 'not_found' // chat or message gone
  | 'session_revoked'
  | 'network'
  | 'unknown';

export class TransportError extends Error {
  constructor(
    public code: TransportErrorCode,
    message: string,
    public retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface SendOptions {
  fromChatId: string;
  /** All ids of the source (album = several) */
  srcMessageIds: number[];
  toChatId: string;
  /** Transformed text/caption to use instead of the original */
  text: RichText;
  silent: boolean;
  removeButtons: boolean;
  mediaKind: string;
}

export interface ResolvedChannel {
  tgChatId: string;
  title: string;
  username?: string;
  isProtected: boolean;
  memberCount?: number;
}

export interface ReaderHandlers {
  onPost(accountId: string, msg: RelayMessage): void | Promise<void>;
  onEdit(accountId: string, msg: RelayMessage): void | Promise<void>;
  onDelete(accountId: string, chatId: string, messageIds: number[]): void | Promise<void>;
}

/**
 * One connected Telegram identity (user account, bot, or the simulator).
 * Implementations: GramJsTransport, BotApiTransport, SimTransport.
 */
export interface Transport {
  readonly accountId: string;
  readonly kind: 'user' | 'bot' | 'sim';

  start(handlers: ReaderHandlers): Promise<void>;
  stop(): Promise<void>;

  /** Re-send content as a fresh post (no "Forwarded from" header). */
  copy(opts: SendOptions): Promise<number[]>;
  /** Native forward (keeps the "Forwarded from" header). */
  forward(opts: Omit<SendOptions, 'text' | 'removeButtons'>): Promise<number[]>;
  editCopy(chatId: string, messageId: number, text: RichText, mediaKind: string): Promise<void>;
  deleteMessages(chatId: string, messageIds: number[]): Promise<void>;

  /** Missed posts in a master since `sinceUnixSeconds` (catch-up after downtime). */
  history(chatId: string, sinceUnixSeconds: number): Promise<RelayMessage[]>;
  resolveChannel(ref: string): Promise<ResolvedChannel>;
  joinChannel(ref: string): Promise<ResolvedChannel>;
}
