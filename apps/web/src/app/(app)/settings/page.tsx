"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Moon, Sun, UserPlus } from "@phosphor-icons/react";
import { SectionHeader, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import {
  useAddMember,
  useAppSettings,
  useAudit,
  useMembers,
  useUpdateAppSettings,
} from "@/lib/queries";

function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.classList.toggle("light", next);
    try {
      localStorage.setItem("sy-theme", next ? "light" : "dark");
    } catch {
      // storage may be unavailable; the toggle still works for this session
    }
  };

  return (
    <Button size="sm" onClick={toggle}>
      {light ? <Moon size={14} /> : <Sun size={14} />}
      {light ? "Switch to dark" : "Switch to light"}
    </Button>
  );
}

function RelaySettings() {
  const { data: settings, isLoading } = useAppSettings();
  const update = useUpdateAppSettings();
  const [retention, setRetention] = useState(30);
  const [catchup, setCatchup] = useState(15);

  useEffect(() => {
    if (settings) {
      setRetention(settings.retention_days);
      setCatchup(settings.catchup_window_minutes);
    }
  }, [settings]);

  if (isLoading) return <Skeleton className="h-32" />;

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
            value={catchup}
            onChange={(e) => setCatchup(Number(e.target.value))}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Team() {
  const { data: members, isLoading } = useMembers();
  const add = useAddMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");

  if (isLoading) return <Skeleton className="h-32" />;

  return (
    <div className="flex flex-col gap-4">
      <ul className="divide-y divide-edge border-y border-edge">
        {(members ?? []).map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <span className="flex size-7 items-center justify-center rounded-full bg-raised font-mono text-[11px] font-semibold uppercase text-mute">
              {m.email.slice(0, 2)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13.5px]">{m.email}</span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-faint">{m.role}</span>
            <span className={`size-1.5 rounded-full ${m.user_id ? "bg-live" : "bg-faint"}`} title={m.user_id ? "activated" : "invited, not signed in yet"} />
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            { email, role },
            {
              onSuccess: () => {
                toast.success(`Invited ${email} — they can now activate their account on the login page`);
                setEmail("");
              },
            },
          );
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <Field label="Invite by email" className="min-w-56 flex-1">
          <Input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
          />
        </Field>
        <Select
          value={role}
          onValueChange={setRole}
          options={[
            { value: "viewer", label: "Viewer — read-only" },
            { value: "admin", label: "Admin — full control" },
          ]}
          className="w-44"
        />
        <Button type="submit" variant="primary" loading={add.isPending}>
          <UserPlus size={14} /> Invite
        </Button>
      </form>
    </div>
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

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-0.5 text-[13px] text-mute">Relay behavior, team access, and the audit trail.</p>
        </div>
        <ThemeToggle />
      </header>

      <section>
        <SectionHeader title="Relay" />
        <RelaySettings />
      </section>

      <section>
        <SectionHeader
          title="Team"
          hint="Invite-only: people you add here can activate their account from the login page."
        />
        <Team />
      </section>

      <section>
        <SectionHeader title="Audit trail" hint="Who changed what, most recent first." />
        <AuditTrail />
      </section>
    </div>
  );
}
