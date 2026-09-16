import type { ChannelRow, ForumTopicRow, RouteRow } from "./types";

/** Telegram's id for a forum's General topic. */
export const GENERAL_TOPIC_ID = 1;

/** Select value meaning "no topic filter" (source) — Radix Select needs a string. */
export const ALL_TOPICS = "all";

const sameChat = (a: number | string | null, b: number | string | null) =>
  a != null && b != null && String(a) === String(b);

/** A group with Topics — flagged on add, or inferred from topics the relay has seen. */
export function isForum(channel: ChannelRow | undefined, topics: ForumTopicRow[] | undefined): boolean {
  if (!channel) return false;
  return channel.is_forum || (topics ?? []).some((t) => sameChat(t.tg_chat_id, channel.tg_chat_id));
}

export function topicName(
  topicId: number | null | undefined,
  channel: ChannelRow | undefined,
  topics: ForumTopicRow[] | undefined,
): string {
  if (topicId == null || topicId === GENERAL_TOPIC_ID) return "General";
  const known = (topics ?? []).find(
    (t) => t.topic_id === topicId && sameChat(t.tg_chat_id, channel?.tg_chat_id ?? null),
  );
  return known?.title || `Topic #${topicId}`;
}

/** Topics of one chat for a Select; General first, then by name. */
export function topicOptions(
  channel: ChannelRow | undefined,
  topics: ForumTopicRow[] | undefined,
  { includeAll }: { includeAll: boolean },
): { value: string; label: string }[] {
  const seen = (topics ?? [])
    .filter((t) => sameChat(t.tg_chat_id, channel?.tg_chat_id ?? null) && t.topic_id !== GENERAL_TOPIC_ID)
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
    .map((t) => ({ value: String(t.topic_id), label: t.title || `Topic #${t.topic_id}` }));
  return [
    ...(includeAll ? [{ value: ALL_TOPICS, label: "All topics" }] : []),
    { value: String(GENERAL_TOPIC_ID), label: "General" },
    ...seen,
  ];
}

/** Select value ⇄ stored column. Source: "all" = null. Target: General = null. */
export const sourceTopicToValue = (id: number | null) => (id == null ? ALL_TOPICS : String(id));
export const valueToSourceTopic = (v: string) => (v === ALL_TOPICS ? null : Number(v));
export const targetTopicToValue = (id: number | null) => String(id ?? GENERAL_TOPIC_ID);
export const valueToTargetTopic = (v: string) => (Number(v) === GENERAL_TOPIC_ID ? null : Number(v));

/** Human summary of a route's topic mapping, or null when neither side uses topics. */
export function describeRouteTopics(
  route: Pick<RouteRow, "source_topic_id" | "target_topic_id">,
  master: ChannelRow | undefined,
  receiver: ChannelRow | undefined,
  topics: ForumTopicRow[] | undefined,
): string | null {
  const parts: string[] = [];
  if (route.source_topic_id != null) parts.push(`from #${topicName(route.source_topic_id, master, topics)}`);
  if (route.target_topic_id != null) parts.push(`into #${topicName(route.target_topic_id, receiver, topics)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
