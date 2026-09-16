/**
 * Shared message model. Mirrors Telegram's entity system: entity offsets and
 * lengths are UTF-16 code units, which conveniently match JavaScript string
 * indexing, so no conversion layer is needed.
 */

export type EntityType =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikethrough'
  | 'spoiler'
  | 'code'
  | 'pre'
  | 'text_link'
  | 'url'
  | 'mention'
  | 'hashtag'
  | 'cashtag'
  | 'bot_command'
  | 'email'
  | 'phone'
  | 'custom_emoji'
  | 'blockquote';

export interface Entity {
  type: EntityType;
  offset: number;
  length: number;
  /** Only for text_link */
  url?: string;
  /** Only for pre */
  language?: string;
}

export interface RichText {
  text: string;
  entities: Entity[];
}

export const MEDIA_KINDS = [
  'text',
  'photo',
  'video',
  'animation',
  'document',
  'audio',
  'voice',
  'sticker',
  'poll',
  'other',
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** A message as it arrives from a master channel, normalized. */
export interface RelayMessage {
  /** Master chat id (stringified Telegram id) */
  chatId: string;
  messageId: number;
  /** Telegram grouped_id when the message is part of an album */
  albumKey?: string;
  /** Unix seconds */
  date: number;
  media: MediaKind;
  /** Message text, or caption for media messages */
  text: RichText;
  hasButtons?: boolean;
  /**
   * Telegram file reference of the media, when the reader provides one. Lets
   * an album be re-sent as ONE grouped album with its transformed caption.
   */
  fileId?: string;
  /** Media is hidden behind a spoiler */
  hasSpoiler?: boolean;
  /**
   * Forum topic the message was posted in (1 = General). Undefined when the
   * chat is not a forum.
   */
  topicId?: number;
}

/** Context the pipeline needs to expand header/footer variables. */
export interface PipelineContext {
  masterTitle: string;
  masterUsername?: string;
  /** Public t.me link to the source message, when the master is public */
  messageLink?: string;
  /** Injectable clock for tests; defaults to new Date() */
  now?: Date;
  /** Timezone used to render {date}/{time} variables; defaults to UTC */
  tz?: string;
}

export const emptyRichText = (): RichText => ({ text: '', entities: [] });

export const richText = (text: string, entities: Entity[] = []): RichText => ({
  text,
  entities,
});
