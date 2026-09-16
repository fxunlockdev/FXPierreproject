"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Broadcast, DotsThreeVertical, LockKey, Plus } from "@phosphor-icons/react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { HealthDot } from "@/components/ui/badge";
import { EmptyState, SectionHeader, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import {
  useChannels,
  useDeleteChannel,
  useInsertChannel,
  useRoutes,
  useUpdateChannel,
} from "@/lib/queries";
import { useSpaceId } from "@/lib/space";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { ChannelRow, DiscoveredChatRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";
import { DiscoveredPicker } from "./discovered-picker";

const HEALTH_LABEL: Record<string, string> = {
  ok: "healthy",
  unknown: "not verified",
  unavailable: "unavailable",
  no_permission: "no permission",
  protected: "protected",
};

function AddChannelDialog() {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"master" | "receiver">("master");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const insert = useInsertChannel();
  const qc = useQueryClient();
  const spaceId = useSpaceId();

  /** Save the row, then have the worker verify it with Telegram right away. */
  const addChannel = async (row: Partial<ChannelRow>, ref: string, label: string) => {
    const { data, error } = await supabaseBrowser()
      .from("channels")
      .insert({ role, ...row, space_id: spaceId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    try {
      const meta = await workerCall<{ title: string; isProtected: boolean }>("channels/resolve", {
        channelId: data.id,
        ref,
      });
      toast.success(
        meta.isProtected
          ? `Added "${meta.title}" — but it has protected content and cannot be relayed`
          : `Added "${meta.title}"`,
      );
    } catch (err) {
      toast.info(
        `Saved "${label}". ${err instanceof Error ? err.message : "Verification will happen once the relay connects."}`,
      );
    }
    // the resolve call just rewrote the row server-side — don't wait for realtime
    void qc.invalidateQueries({ queryKey: ["channels"] });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const cleanRef = ref.trim();
      const username = /^@?[A-Za-z]\w{3,31}$/.test(cleanRef.replace(/^@/, ""))
        ? cleanRef.replace(/^@/, "")
        : null;
      await addChannel(
        { title: cleanRef.replace(/^@/, ""), username, invite_link: username ? null : cleanRef },
        cleanRef,
        cleanRef,
      );
      setRef("");
      setOpen(false);
      insert.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Picking keeps the dialog open: the chat drops off the list, add the next one.
  const pick = async (chat: DiscoveredChatRow) => {
    const chatId = String(chat.tg_chat_id);
    setPicking(chatId);
    try {
      await addChannel(
        {
          tg_chat_id: chatId,
          title: chat.title,
          username: chat.username,
          chat_type: chat.chat_type,
          is_forum: chat.is_forum,
        },
        chatId,
        chat.title,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus size={14} weight="bold" /> Add channel
        </Button>
      </DialogTrigger>
      <DialogContent
        wide
        title="Add a channel or group"
        description="Pick a chat the bot is already in — private channels and groups included."
      >
        <div className="flex flex-col gap-5">
          <Field label="Role">
            <Select
              value={role}
              onValueChange={(v) => setRole(v as "master" | "receiver")}
              options={[
                { value: "master", label: "Master — source we watch" },
                { value: "receiver", label: "Receiver — destination we post to" },
              ]}
            />
          </Field>

          <section aria-label="Chats the bot can see">
            <p className="mb-2 text-[13px] font-medium text-mute">Chats the bot can see</p>
            <DiscoveredPicker role={role} busyChatId={picking} onPick={pick} />
          </section>

          <form onSubmit={submit} className="flex flex-col gap-4 border-t border-edge pt-5">
            <Field
              label="Username or link"
              hint="Public @username, t.me link, or a post link from a private chat (… → Copy post link). Invite links (t.me/+…) can’t be used by bots — pick from the list above instead."
            >
              <Input
                required
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="@channel · t.me/name · t.me/c/1234567890/5"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Done
              </Button>
              <Button type="submit" variant="primary" loading={busy}>
                Add channel
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChannelRowItem({ channel, routeCount }: { channel: ChannelRow; routeCount: number }) {
  const update = useUpdateChannel();
  const remove = useDeleteChannel();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-center gap-3 py-3">
      <HealthDot health={channel.health} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[13.5px] font-medium">{channel.title || "(untitled)"}</p>
          {channel.is_protected && (
            <span title="Protected content — Telegram forbids relaying from this channel">
              <LockKey size={13} className="text-warn" weight="fill" />
            </span>
          )}
        </div>
        <p className="truncate font-mono text-[11.5px] text-faint">
          {channel.chat_type &&
            `${channel.chat_type === "channel" ? "channel" : channel.is_forum ? "group with topics" : "group"} · `}
          {channel.username
            ? `@${channel.username}`
            : channel.tg_chat_id != null
              ? "private"
              : (channel.invite_link ?? "unresolved")}
          {" · "}
          {HEALTH_LABEL[channel.health] ?? channel.health}
          {channel.role === "master" && ` · last post ${timeAgo(channel.last_message_at)}`}
          {routeCount > 0 && ` · ${routeCount} route${routeCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <Switch
        checked={channel.enabled}
        label={`Enable ${channel.title}`}
        onCheckedChange={(enabled) => update.mutate({ id: channel.id, patch: { enabled } })}
      />
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button
            aria-label={`Options for ${channel.title}`}
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            <DotsThreeVertical size={16} weight="bold" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-44 rounded-lg border border-edge bg-raised p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.55)]"
          >
            <Dropdown.Item
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[13px] text-mute outline-none data-[highlighted]:bg-surface data-[highlighted]:text-ink"
              onSelect={async () => {
                try {
                  const meta = await workerCall<{ title: string }>("channels/resolve", {
                    channelId: channel.id,
                    // a known chat id always resolves; invite links never do for bots
                    ref: channel.username
                      ? `@${channel.username}`
                      : channel.tg_chat_id != null
                        ? String(channel.tg_chat_id)
                        : (channel.invite_link ?? ""),
                  });
                  toast.success(`Verified "${meta.title}"`);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              Re-verify with Telegram
            </Dropdown.Item>
            <Dropdown.Item
              className="cursor-pointer rounded-md px-2.5 py-1.5 text-[13px] text-danger outline-none data-[highlighted]:bg-danger-soft"
              onSelect={(e) => {
                e.preventDefault();
                setConfirming(true);
              }}
            >
              Remove…
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent
          title={`Remove ${channel.title}?`}
          description={
            routeCount > 0
              ? `This also deletes its ${routeCount} route${routeCount === 1 ? "" : "s"} and their history.`
              : "This deletes the channel and its history."
          }
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(channel.id, {
                  onSuccess: () => {
                    setConfirming(false);
                    toast.success(`Removed ${channel.title}`);
                  },
                })
              }
            >
              Remove channel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export default function ChannelsPage() {
  const { data: channels, isLoading } = useChannels();
  const { data: routes } = useRoutes();

  const masters = (channels ?? []).filter((c) => c.role === "master");
  const receivers = (channels ?? []).filter((c) => c.role === "receiver");
  const routeCount = (id: string) =>
    (routes ?? []).filter((r) => r.master_id === id || r.receiver_id === id).length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Channels</h1>
          <p className="mt-0.5 text-[13px] text-mute">
            Channels and groups. Masters are watched; receivers get the posts. Toggle any of them off without restarts.
          </p>
        </div>
        <AddChannelDialog />
      </header>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-2">
          <section>
            <SectionHeader title={`Masters — ${masters.length}`} hint="Sources being watched" />
            {masters.length === 0 ? (
              <EmptyState
                icon={<Broadcast size={20} />}
                title="No master channels yet"
                hint="Add the channels you want to relay from."
              />
            ) : (
              <ul className="divide-y divide-edge border-y border-edge">
                {masters.map((c) => (
                  <ChannelRowItem key={c.id} channel={c} routeCount={routeCount(c.id)} />
                ))}
              </ul>
            )}
          </section>
          <section>
            <SectionHeader title={`Receivers — ${receivers.length}`} hint="Destinations being posted to" />
            {receivers.length === 0 ? (
              <EmptyState
                icon={<Broadcast size={20} />}
                title="No receivers yet"
                hint="Add the channels that should get the relayed posts."
              />
            ) : (
              <ul className="divide-y divide-edge border-y border-edge">
                {receivers.map((c) => (
                  <ChannelRowItem key={c.id} channel={c} routeCount={routeCount(c.id)} />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {(channels ?? []).some((c) => c.is_protected) && (
        <p className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2.5 text-[13px] leading-relaxed text-warn">
          <LockKey size={15} weight="fill" className="mt-0.5 shrink-0" />
          Channels marked with a lock have &ldquo;Restrict saving content&rdquo; enabled on Telegram.
          Their posts cannot be relayed by any tool — ask the channel owner to disable it.
        </p>
      )}
    </div>
  );
}
