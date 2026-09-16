"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Moon, Sun } from "@phosphor-icons/react";
import { JoinSpaceForm } from "@/components/shell/join-space-form";
import { SectionHeader, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { timeAgo } from "@/lib/format";
import { isLightTheme, serverIsLightTheme, subscribeTheme, toggleTheme } from "@/lib/theme";
import { useAppSettings, useAudit, useRenameSpace, useUpdateAppSettings } from "@/lib/queries";
import { useSpace } from "@/lib/space";
import { Team } from "./team";

function ThemeToggle() {
  const light = useSyncExternalStore(subscribeTheme, isLightTheme, serverIsLightTheme);

  return (
    <Button size="sm" onClick={toggleTheme}>
      {light ? <Moon size={14} /> : <Sun size={14} />}
      {light ? "Switch to dark" : "Switch to light"}
    </Button>
  );
}

function RelaySettings() {
  const { data: settings, isLoading } = useAppSettings();
  if (isLoading || !settings) return <Skeleton className="h-32" />;
  return <RelayForm key={settings.space_id} settings={settings} />;
}

type AppSettingsRow = NonNullable<ReturnType<typeof useAppSettings>["data"]>;

function RelayForm({ settings }: { settings: AppSettingsRow }) {
  const update = useUpdateAppSettings();
  const { canEdit } = useSpace();
  // Seeded from the server row once — refetches must not stomp in-progress edits.
  const [retention, setRetention] = useState(settings.retention_days);
  const [catchup, setCatchup] = useState(settings.catchup_window_minutes);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          { retention_days: retention, catchup_window_minutes: catchup },
          { onSuccess: () => toast.success("Relay settings saved") },
        );
      }}
      className="flex flex-col gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Log retention (days)" hint="Older forward history is purged nightly.">
          <Input
            type="number"
            min={1}
            max={365}
            disabled={!canEdit}
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value))}
          />
        </Field>
        <Field
          label="Catch-up window (minutes)"
          hint="After downtime, posts newer than this are relayed; older ones are skipped so stale signals never go out."
        >
          <Input
            type="number"
            min={0}
            max={1440}
            disabled={!canEdit}
            value={catchup}
            onChange={(e) => setCatchup(Number(e.target.value))}
          />
        </Field>
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={update.isPending}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}

function SpaceDetails() {
  const router = useRouter();
  const { space, canEdit } = useSpace();
  const rename = useRenameSpace();
  const [name, setName] = useState(space.name);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        rename.mutate(name, {
          onSuccess: () => {
            toast.success("Space renamed");
            router.refresh();
          },
        });
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <Field
        label="Space name"
        hint="Everything in this space — bots, channels, routes and logs — is private to its members."
        className="min-w-56 flex-1"
      >
        <Input
          required
          maxLength={80}
          disabled={!canEdit}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {canEdit && (
        <Button type="submit" variant="primary" loading={rename.isPending} disabled={name.trim() === space.name}>
          Rename
        </Button>
      )}
    </form>
  );
}

function AuditTrail() {
  const { data: audit, isLoading } = useAudit();
  if (isLoading) return <Skeleton className="h-32" />;
  if ((audit ?? []).length === 0)
    return <p className="text-[13px] text-mute">No configuration changes recorded yet.</p>;

  return (
    <ul className="divide-y divide-edge border-y border-edge">
      {(audit ?? []).map((a) => (
        <li key={a.id} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-mute">
            <span className="text-ink">{a.actor}</span> {a.action}d{" "}
            <span className="font-mono text-[11.5px]">{a.entity}</span>
          </span>
          <span className="shrink-0 font-mono text-[11px] text-faint">{timeAgo(a.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function JoinAnother() {
  const { switchSpace } = useSpace();
  return <JoinSpaceForm compact onJoined={switchSpace} />;
}

/** Re-seed the forms when the user switches space. */
function SpaceKeyed() {
  const { space } = useSpace();
  return <SpaceDetails key={`${space.id}:${space.name}`} />;
}

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-0.5 text-[13px] text-mute">Your space, relay behavior, team access, and the audit trail.</p>
        </div>
        <ThemeToggle />
      </header>

      <section>
        <SectionHeader title="Space" />
        <SpaceKeyed />
      </section>

      <section>
        <SectionHeader title="Relay" />
        <RelaySettings />
      </section>

      <section>
        <SectionHeader title="Team" hint="Members of this space. Nobody outside it can see its data." />
        <Team />
      </section>

      <section>
        <SectionHeader
          title="Join another space"
          hint="Got an invite code from someone else's space? Enter it to add that space to your switcher."
        />
        <div className="max-w-md">
          <JoinAnother />
        </div>
      </section>

      <section>
        <SectionHeader title="Audit trail" hint="Who changed what, most recent first." />
        <AuditTrail />
      </section>
    </div>
  );
}
