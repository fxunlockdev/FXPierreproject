"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Key, Trash } from "@phosphor-icons/react";
import { Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { useCreateInvite, useMembers, useRemoveMember } from "@/lib/queries";
import { useSpace } from "@/lib/space";
import type { SpaceMemberRow } from "@/lib/types";

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Copy failed — select the text and copy it manually");
  }
}

function MemberItem({ member, canEdit }: { member: SpaceMemberRow; canEdit: boolean }) {
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);
  const removable = canEdit && member.role !== "owner";

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="flex size-7 items-center justify-center rounded-full bg-raised font-mono text-[11px] font-semibold uppercase text-mute">
        {member.email.slice(0, 2)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{member.email}</span>
      <span className="hidden font-mono text-[11px] text-faint sm:inline">joined {timeAgo(member.created_at)}</span>
      <span className="w-16 text-right font-mono text-[11px] uppercase tracking-wider text-faint">{member.role}</span>
      {removable &&
        (confirming ? (
          <span className="flex items-center gap-1">
            <Button
              size="sm"
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(member.user_id, {
                  onSuccess: () => toast.success(`${member.email} no longer has access`),
                  onSettled: () => setConfirming(false),
                })
              }
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            aria-label={`Remove ${member.email}`}
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-danger-soft hover:text-danger"
          >
            <Trash size={14} />
          </button>
        ))}
    </li>
  );
}

function InviteCreator() {
  const create = useCreateInvite();
  const [role, setRole] = useState<"viewer" | "admin">("viewer");
  const [code, setCode] = useState<string | null>(null);
  const link = code ? `${window.location.origin}/login?mode=signup&code=${encodeURIComponent(code)}` : null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-edge bg-raised/40 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">Invite a teammate</p>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-mute">
            Creates a one-time code, valid for 7 days. New people use it when creating their account;
            people who already have an account enter it under “Join another space”.
          </p>
        </div>
        <Select
          aria-label="Invite role"
          value={role}
          onValueChange={(v) => setRole(v === "admin" ? "admin" : "viewer")}
          options={[
            { value: "viewer", label: "Viewer — read-only" },
            { value: "admin", label: "Admin — full control" },
          ]}
          className="w-44"
        />
        <Button
          variant="primary"
          loading={create.isPending}
          onClick={() => create.mutate({ role }, { onSuccess: (c) => setCode(c) })}
        >
          <Key size={14} /> Create code
        </Button>
      </div>

      {code && link && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-live/30 bg-live-soft/40 p-3">
          <p className="text-[12px] text-mute">Shown once — copy it now.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code data-testid="invite-code" className="font-mono text-lg font-semibold tracking-[0.12em] text-ink">
              {code}
            </code>
            <Button size="sm" onClick={() => void copy(code, "Code")}>
              <Copy size={13} /> Copy code
            </Button>
            <Button size="sm" onClick={() => void copy(link, "Sign-up link")}>
              <Copy size={13} /> Copy sign-up link
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Team() {
  const { canEdit } = useSpace();
  const { data: members, isLoading } = useMembers();

  if (isLoading) return <Skeleton className="h-32" />;

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-edge border-y border-edge">
        {(members ?? []).map((m) => (
          <MemberItem key={m.user_id} member={m} canEdit={canEdit} />
        ))}
      </ul>
      {canEdit && <InviteCreator />}
    </div>
  );
}
