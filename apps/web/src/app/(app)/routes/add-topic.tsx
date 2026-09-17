"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { useSpace } from "@/lib/space";
import type { ChannelRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";

/**
 * Bots only learn a topic when a message is posted in it, so a quiet topic
 * never shows up on its own. This adds one from the link Telegram copies.
 */
export function AddTopicButton({
  channel,
  onAdded,
  label = "Add topic",
}: {
  channel: ChannelRow;
  onAdded?: (topicId: number) => void;
  label?: string;
}) {
  const { canEdit } = useSpace();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // the route editor around this dialog is a form too
    setBusy(true);
    setError(null);
    try {
      const res = await workerCall<{ topicId: number; title: string }>("topics/add", {
        channelId: channel.id,
        ref: ref.trim(),
        title: title.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["forum_topics"] });
      toast.success(`Topic “${res.title || `#${res.topicId}`}” added`);
      onAdded?.(res.topicId);
      setOpen(false);
      setRef("");
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="self-start">
          <Plus size={13} weight="bold" /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Add a topic from ${channel.title}`}
        description="For topics nobody has posted in since your bot joined."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label="Topic link"
            hint="In Telegram, right-click the topic (on a phone, long-press it) → Copy link. It looks like t.me/c/1234567890/5."
          >
            <Input
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="https://t.me/c/1234567890/5"
            />
          </Field>
          <Field label="Topic name" hint="How it's listed here. The real name replaces it once someone posts in the topic.">
            <Input
              maxLength={128}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. GOLD Scalp"
            />
          </Field>
          {error && (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Add topic
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
