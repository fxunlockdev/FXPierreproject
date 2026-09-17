import type { MediaKind, RelayMessage, RichText } from '@pierre/core';

/** Normalized failure classes the sender knows how to react to. */
export type TransportErrorCode =
  | 'flood_wait' // retry after `retryAfterSeconds`
  | 'forbidden' // no permission to post/edit in the target
  | 'protected' // source restricts forwarding/copying
  | 'not_found' // the TARGET chat is gone
  | 'rejected' // Telegram refused this particular message — retrying won't help
  | 'session_revoked'
  | 'network'
  | 'unknown';

/** One item of an album, as needed to re-send the album grouped. */
export interface AlbumItem {
  messageId: number;
  media: MediaKind;
  fileId?: string;
  /** Telegram file ids are per bot: only this account may send by `fileId`. */
  fileAccountId?: string;
  hasSpoiler?: boolean;
}

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
  /** Per-item details for albums, aligned with srcMessageIds. */
  items?: AlbumItem[];
  /** Post into this forum topic of the target (omit / 1 = General). */
  topicId?: number | null;
  /**
   * Checkpoint callback: transports that send albums item by item (Bot API)
   * MUST await it after each item with all dest ids so far, so the engine can
   * persist progress and a retry never re-sends delivered items.
   */
  onSent?: (destIdsSoFar: number[]) => void | Promise<void>;
  /**
   * false on album resumes — the caption went out with the first item on a
   * previous attempt, so no item of this batch may carry it. Default true.
   */
  applyCaption?: boolean;
}

export type ChatType = 'channel' | 'supergroup' | 'group';

/** Topic id of a forum's General topic. Posting there needs no thread id. */
export const GENERAL_TOPIC_ID = 1;

export interface ResolvedChannel {
  tgChatId: string;
  title: string;
  username?: string;
  isProtected: boolean;
  memberCount?: number;
  chatType?: ChatType;
  /** A group with Topics enabled */
  isForum?: boolean;
}

/** A chat an account is (or was) in — powers pick-from-list in the dashboard. */
export interface DiscoveredChat {
  tgChatId: string;
  chatType: ChatType;
  title: string;
  username?: string;
  status: 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  /** Receives every new message there (admin, or group privacy mode off). */
  canRead: boolean;
  canPost: boolean;
  isForum: boolean;
}

export interface ReaderHandlers {
  onPost(accountId: string, msg: RelayMessage): void | Promise<void>;
  onEdit(accountId: string, msg: RelayMessage): void | Promise<void>;
  onDelete(accountId: string, chatId: string, messageIds: number[]): void | Promise<void>;
  /** Membership changed, or a message revealed a chat — record it. */
  onChatSeen?(accountId: string, chat: DiscoveredChat, membershipChanged: boolean): void | Promise<void>;
  /** A basic group became a supergroup and got a new id. */
  onChatMigrated?(oldChatId: string, newChatId: string): void | Promise<void>;
  /** A message revealed a forum topic (title is '' when Telegram didn't say). */
  onTopicSeen?(accountId: string, chatId: string, topicId: number, title: string): void | Promise<void>;
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
  /**
   * Confirm a forum topic exists and can be posted into; resolves with its
   * name when Telegram reveals it. Throws 'rejected' when the topic is gone.
   */
  checkTopic?(chatId: string, topicId: number): Promise<{ title?: string }>;
  /**
   * Step by step: can this account post into the chat, and will posts appear
   * under the chat's own name? Powers "Check this account" in the dashboard.
   */
  checkAccess?(chatId: string, topicId?: number | null): Promise<AccessCheck[]>;
}

export interface AccessCheck {
  label: string;
  ok: boolean;
  /** What is wrong and how to fix it (or a useful fact when ok). */
  detail?: string;
}
