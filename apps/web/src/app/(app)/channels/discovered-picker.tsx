"use client";

import { CheckCircle, Plus, UsersThree, Megaphone, Warning } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { useAccounts, useChannels, useDiscoveredChats } from "@/lib/queries";
import type { DiscoveredChatRow } from "@/lib/types";

const PRESENT = new Set(["administrator", "member", "restricted"]);

/** What the bot still needs in this chat to play the chosen role, or null if ready. */
function missingRight(chat: DiscoveredChatRow, role: "master" | "receiver"): string | null {
  if (role === "receiver") {
    if (chat.can_post) return null;
    return chat.chat_type === "channel"
      ? "Make the bot admin with “Post messages”"
      : "The bot isn’t allowed to send messages here";
  }
  if (chat.can_read) return null;
  return chat.chat_type === "channel"
    ? "Make the bot admin to receive posts"
    : "Make the bot admin, or turn group privacy off in @BotFather";
}

/**
 * Chats the connected accounts are in, as seen by the relay — the only way a
 * bot can add private channels and groups (it cannot open invite links).
 */
export function DiscoveredPicker({
  role,
  busyChatId,
  onPick,
}: {
  role: "master" | "receiver";
  busyChatId: string | null;
  onPick: (chat: DiscoveredChatRow) => void;
}) {
  const { data: discovered, isLoading } = useDiscoveredChats();
  const { data: channels } = useChannels();
  const { data: accounts } = useAccounts();

  const alreadyAdded = new Set(
    (channels ?? [])
      .filter((c) => c.role === role && c.tg_chat_id != null)
      .map((c) => String(c.tg_chat_id)),
  );
  // With several bots, each reports the same chat: merge them, rights = any bot.
  const byChat = new Map<string, DiscoveredChatRow & { bots: number }>();
  for (const c of discovered ?? []) {
    const id = String(c.tg_chat_id);
    if (!PRESENT.has(c.status) || alreadyAdded.has(id)) continue;
    const merged = byChat.get(id);
    byChat.set(
      id,
      merged
        ? {
            ...merged,
            can_read: merged.can_read || c.can_read,
            can_post: merged.can_post || c.can_post,
            is_forum: merged.is_forum || c.is_forum,
            bots: merged.bots + 1,
          }
        : { ...c, bots: 1 },
    );
  }
  const chats = [...byChat.values()];
  const bot = (accounts ?? []).find((a) => a.kind === "bot" && a.username);

  if (isLoading) return <Skeleton className="h-24" />;

  if (chats.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge px-4 py-5 text-center">
        <p className="text-[13px] font-medium">No new chats yet</p>
        <p className="mx-auto mt-1 max-w-xs text-[12.5px] leading-relaxed text-mute">
          Add {bot?.username ? <span className="font-mono text-ink">@{bot.username}</span> : "the bot"} to
          a channel or group, then post anything there — it shows up here within a second.
        </p>
      </div>
    );
  }

  return (
    <ul className="max-h-72 divide-y divide-edge overflow-y-auto rounded-lg border border-edge">
      {chats.map((chat) => {
        const id = String(chat.tg_chat_id);
        const missing = missingRight(chat, role);
        const Icon = chat.chat_type === "channel" ? Megaphone : UsersThree;
        return (
          <li key={id} className="flex items-center gap-3 px-3 py-2.5">
            <Icon size={17} className="shrink-0 text-faint" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-[13px] font-medium">{chat.title || "(untitled)"}</p>
                <Badge>{chat.chat_type === "channel" ? "channel" : "group"}</Badge>
              </div>
              <p
                className={`mt-0.5 flex items-center gap-1 truncate text-[12px] ${missing ? "text-warn" : "text-faint"}`}
              >
                {missing ? (
                  <>
                    <Warning size={12} weight="fill" className="shrink-0" /> {missing}
                  </>
                ) : (
                  <>
                    <CheckCircle size={12} weight="fill" className="shrink-0 text-live" />
                    {chat.username ? `@${chat.username}` : "private"} · ready
                    {chat.bots > 1 && ` · ${chat.bots} bots`}
                  </>
                )}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={missing ? "ghost" : "primary"}
              loading={busyChatId === id}
              disabled={busyChatId !== null && busyChatId !== id}
              onClick={() => onPick(chat)}
            >
              <Plus size={13} weight="bold" /> Add
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
