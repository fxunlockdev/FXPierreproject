"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ShieldStar, Users } from "@phosphor-icons/react";
import { EmptyState, SectionHeader, Skeleton, Stat } from "@/components/ui/bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import { useAdminSpaces, useSetSignupsOpen, useSetSpaceDisabled, useSignupsOpen } from "@/lib/queries";
import { useSpace } from "@/lib/space";
import type { AdminSpaceRow } from "@/lib/types";

function SignupsToggle() {
  const { data: open, isLoading } = useSignupsOpen();
  const set = useSetSignupsOpen();
  if (isLoading || open === undefined) return <Skeleton className="h-16" />;

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-surface px-5 py-4">
      <div>
        <p className="text-[13.5px] font-medium">Open sign-ups</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-mute">
          {open
            ? "Anyone can create an account and gets their own blank, private space."
            : "Closed — only people holding a valid invite code can create an account."}
        </p>
      </div>
      <Switch
        label="Open sign-ups"
        checked={open}
        disabled={set.isPending}
        onCheckedChange={(next) =>
          set.mutate(next, {
            onSuccess: () => toast.success(next ? "Sign-ups are open" : "Sign-ups are closed"),
          })
        }
      />
    </div>
  );
}

function SpaceRow({ row, isOwn }: { row: AdminSpaceRow; isOwn: boolean }) {
  const set = useSetSpaceDisabled();
  const [confirming, setConfirming] = useState(false);

  const toggle = (disabled: boolean) =>
    set.mutate(
      { id: row.id, disabled },
      {
        onSuccess: () => toast.success(disabled ? `${row.name} disabled` : `${row.name} re-enabled`),
        onSettled: () => setConfirming(false),
      },
    );

  return (
    <tr className="border-b border-edge last:border-0">
      <td className="py-3 pr-4">
        <p className="max-w-56 truncate text-[13.5px] font-medium" title={row.name}>
          {row.name}
          {isOwn && <span className="ml-2 font-mono text-[10.5px] uppercase text-faint">yours</span>}
        </p>
        <p className="max-w-56 truncate text-[12px] text-mute">{row.owner_email ?? "no owner"}</p>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 font-mono text-[12px] text-faint">{timeAgo(row.created_at)}</td>
      <td className="tabular py-3 pr-4 text-right font-mono text-[12.5px]">{row.members}</td>
      <td className="tabular py-3 pr-4 text-right font-mono text-[12.5px]">{row.bots}</td>
      <td className="tabular py-3 pr-4 text-right font-mono text-[12.5px]">{row.channels}</td>
      <td className="tabular py-3 pr-4 text-right font-mono text-[12.5px]">{row.routes}</td>
      <td className="tabular py-3 pr-4 text-right font-mono text-[12.5px]">{row.forwards_24h}</td>
      <td className="py-3 pr-4">
        <Badge tone={row.disabled ? "danger" : "live"}>{row.disabled ? "disabled" : "active"}</Badge>
      </td>
      <td className="py-3 text-right">
        {row.disabled ? (
          <Button size="sm" loading={set.isPending} onClick={() => toggle(false)}>
            Enable
          </Button>
        ) : confirming ? (
          <span className="inline-flex gap-1">
            <Button size="sm" variant="danger" loading={set.isPending} onClick={() => toggle(true)}>
              Disable
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" disabled={isOwn} onClick={() => setConfirming(true)}>
            Disable…
          </Button>
        )}
      </td>
    </tr>
  );
}

export function AdminConsole() {
  const { spaces: mine } = useSpace();
  const { data: rows, isLoading } = useAdminSpaces();
  const ownIds = new Set(mine.map((s) => s.id));
  const all = rows ?? [];
  const active = all.filter((r) => !r.disabled);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-live">
          <ShieldStar size={12} weight="fill" /> Platform
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-mute">
          Every client space at a glance. You see counts only — never their bots, channels or messages.
          Disabling a space stops its relaying immediately and hides it from its members.
        </p>
      </header>

      <SignupsToggle />

      {isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="grid grid-cols-2 divide-edge border-y border-edge sm:grid-cols-4 sm:divide-x">
          <Stat label="Spaces" value={String(all.length)} />
          <Stat label="Active" value={String(active.length)} tone="live" />
          <Stat label="Bots" value={String(all.reduce((n, r) => n + r.bots, 0))} />
          <Stat label="Forwards 24h" value={String(all.reduce((n, r) => n + r.forwards_24h, 0))} />
        </div>
      )}

      <section>
        <SectionHeader title="Spaces" hint="Oldest first." />
        {isLoading ? (
          <Skeleton className="h-40" />
        ) : all.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No spaces yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-edge text-[11px] uppercase tracking-[0.08em] text-faint">
                  <th className="py-2 pr-4 font-medium">Space</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 text-right font-medium">Members</th>
                  <th className="py-2 pr-4 text-right font-medium">Bots</th>
                  <th className="py-2 pr-4 text-right font-medium">Channels</th>
                  <th className="py-2 pr-4 text-right font-medium">Routes</th>
                  <th className="py-2 pr-4 text-right font-medium">24h</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {all.map((r) => (
                  <SpaceRow key={r.id} row={r} isOwn={ownIds.has(r.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
