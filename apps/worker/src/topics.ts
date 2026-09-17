import { TransportError } from './transport/transport';

export interface TopicRef {
  topicId: number;
  /** Chat id the link points at (private groups: t.me/c/…). */
  chatId?: string;
  /** Public group username the link points at (t.me/<name>/…). */
  username?: string;
}

const HOW_TO =
  'paste the topic link — in Telegram, right-click the topic (on a phone, long-press it) → Copy link. ' +
  'It looks like t.me/c/1234567890/5';

const T_ME = String.raw`^(?:https?:\/\/)?(?:www\.)?t\.me\/`;
const TAIL = String.raw`\/?(?:\?[^#]*)?(?:#.*)?$`;
const PRIVATE_LINK = new RegExp(`${T_ME}c\\/(\\d+)\\/(\\d+)(?:\\/(\\d+))?${TAIL}`, 'i');
const PUBLIC_LINK = new RegExp(`${T_ME}([A-Za-z]\\w{3,31})\\/(\\d+)(?:\\/(\\d+))?${TAIL}`, 'i');

function topicId(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw new TransportError('rejected', HOW_TO);
  return id;
}

/** `?thread=N` on older message links names the topic; the path then holds only the message id. */
function threadParam(link: string): string | undefined {
  return /[?&]thread=(\d+)/i.exec(link)?.[1];
}

/**
 * A forum topic as people paste it: the topic's own link (… → Copy link), a
 * link to a message inside the topic, or the bare topic id.
 */
export function parseTopicRef(raw: string): TopicRef {
  const ref = raw.trim();
  if (/^\d+$/.test(ref)) return { topicId: topicId(ref) };

  const priv = PRIVATE_LINK.exec(ref);
  if (priv) {
    const thread = threadParam(ref);
    return { chatId: `-100${priv[1]}`, topicId: topicId(thread ?? priv[2]) };
  }

  const pub = PUBLIC_LINK.exec(ref);
  if (pub && !['joinchat', 'addstickers', 'share'].includes(pub[1]!.toLowerCase())) {
    const thread = threadParam(ref);
    return { username: pub[1]!, topicId: topicId(thread ?? pub[2]) };
  }

  throw new TransportError('rejected', HOW_TO);
}
