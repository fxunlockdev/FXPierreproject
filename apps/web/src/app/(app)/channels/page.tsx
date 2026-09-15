"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Broadcast, DotsThreeVertical, LockKey, Plus } from "@phosphor-icons/react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Badge, HealthDot } from "@/components/ui/badge";
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
import { supabaseBrowser } from "@/lib/supabase/client";
import type { ChannelRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";

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
  const insert = useInsertChannel();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const cleanRef = ref.trim();
      const username = /^@?[A-Za-z]\w{3,31}$/.test(cleanRef.replace(/^@/, ""))
        ? cleanRef.replace(/^@/, "")
        : null;
      const { data, error } = await supabaseBrowser()
        .from("channels")
        .insert({
          role,
          title: cleanRef.replace(/^@/, ""),
          username,
          invite_link: username ? null : cleanRef,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);

      // Best effort: ask the worker to resolve real metadata right away.
      try {
        const meta = await workerCall<{ title: string; isProtected: boolean }>("channels/resolve", {
          channelId: data.id,
          ref: cleanRef,
        });
        toast.success(
          meta.isProtected
            ? `Added "${meta.title}" — but it has protected content and cannot be relayed`
            : `Added "${meta.title}"`,
        );
      } catch (err) {
        toast.info(
          `Channel saved. ${err instanceof Error ? err.message : "Verification will happen once the relay connects."}`,
        );
      }
      setRef("");
      setOpen(false);
      insert.reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
        title="Add a channel"
        description="Paste a public @username or a t.me invite link."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
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
          <Field
            label="Channel"
            hint={
              role === "master"
                ? "The reader account must be a member of this channel."
                : "The sender account or bot must be an admin with Post rights here."
            }
          >
            <Input
              required
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="@channel or https://t.me/+AbCdEf…"
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Add channel
            </Button>
          </div>
        </form>
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
          {channel.username ? `@${channel.username}` : channel.invite_link ?? "unresolved"}
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
                    ref: channel.username ? `@${channel.username}` : (channel.invite_link ?? ""),
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
            Masters are watched; receivers get the posts. Toggle any channel off without restarts.
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
