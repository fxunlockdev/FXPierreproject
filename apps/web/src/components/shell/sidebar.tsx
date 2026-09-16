"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  Bell,
  Broadcast,
  GearSix,
  Graph,
  IdentificationBadge,
  List,
  ListChecks,
  SignOut,
  ShieldStar,
  SquaresFour,
  X,
} from "@phosphor-icons/react";
import { Select } from "@/components/ui/select";
import { useIncidents, usePendingCount, useRelayStatus } from "@/lib/queries";
import { useSpace } from "@/lib/space";
import { supabaseBrowser } from "@/lib/supabase/client";
import { timeAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const NAV = [
  { href: "/overview", label: "Overview", icon: SquaresFour },
  { href: "/routes", label: "Routes", icon: Graph },
  { href: "/channels", label: "Channels", icon: Broadcast },
  { href: "/accounts", label: "Accounts", icon: IdentificationBadge },
  { href: "/activity", label: "Activity", icon: ListChecks },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Settings", icon: GearSix },
] as const;

function WorkerPill() {
  const { data: latest } = useRelayStatus();
  const { data: pending } = usePendingCount();

  const now = useNow(15_000);
  const age = latest ? now - new Date(latest.heartbeat_at).getTime() : Infinity;
  const state = age < 90_000 ? "online" : age < 300_000 ? "stale" : "offline";
  const color = state === "online" ? "bg-live" : state === "stale" ? "bg-warn" : "bg-danger";
  const label =
    state === "online"
      ? `Relay online${latest?.simulate ? " · sim" : ""}`
      : state === "stale"
        ? "Relay stale"
        : "Relay offline";

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-raised px-3 py-2.5">
      <span className={`size-2 rounded-full ${color} ${state === "online" ? "pulse-live" : ""}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-ink">{label}</p>
        <p className="truncate font-mono text-[11px] text-faint">
          {latest ? `queue ${pending ?? 0} · beat ${timeAgo(latest.heartbeat_at)}` : "no heartbeat yet"}
        </p>
      </div>
    </div>
  );
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", viewer: "Viewer" } as const;

function SpaceSwitcher() {
  const { space, spaces, switchSpace } = useSpace();
  return (
    <div className="flex flex-col gap-1.5 px-1">
      <span className="px-1 text-[10.5px] font-medium uppercase tracking-[0.12em] text-faint">Space</span>
      {spaces.length > 1 ? (
        <Select
          aria-label="Switch space"
          value={space.id}
          onValueChange={switchSpace}
          options={spaces.map((s) => ({ value: s.id, label: s.name }))}
          className="w-full"
        />
      ) : (
        <p className="truncate rounded-lg border border-edge bg-raised px-3 py-2 text-[13px] font-medium text-ink" title={space.name}>
          {space.name}
        </p>
      )}
      <span className="px-1 text-[11px] text-faint">
        {ROLE_LABEL[space.role]}
        {space.role === "viewer" ? " · read-only" : ""}
      </span>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: incidents } = useIncidents();
  const openCount = incidents?.filter((i) => i.status === "open").length ?? 0;
  const { isPlatformAdmin } = useSpace();
  const items = isPlatformAdmin ? [...NAV, { href: "/admin", label: "Admin", icon: ShieldStar }] : NAV;

  return (
    <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-0.5">
      {items.map(({ href, label, icon: Icon }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors ${
              active ? "bg-raised text-ink" : "text-mute hover:bg-raised/60 hover:text-ink"
            }`}
          >
            <Icon size={17} weight={active ? "fill" : "regular"} className={active ? "text-live" : ""} />
            <span className="flex-1">{label}</span>
            {href === "/alerts" && openCount > 0 && (
              <span className="rounded-md bg-danger-soft px-1.5 font-mono text-[11px] font-semibold text-danger">
                {openCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/overview" className="flex items-center gap-2.5 px-2">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden className="shrink-0">
        <rect x="1" y="1" width="24" height="24" rx="7" className="fill-none stroke-[var(--edge-strong)]" />
        <path d="M6 9h6.5a3 3 0 0 1 0 6H10" className="fill-none stroke-[var(--live)]" strokeWidth="2" strokeLinecap="round" />
        <circle cx="19" cy="17" r="2.4" className="fill-[var(--live)]" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">
        Switchyard
        <span className="ml-2 hidden font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-faint lg:inline">
          relay ops
        </span>
      </span>
    </Link>
  );
}

function SignOutButton({ email }: { email: string }) {
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-2 px-2 pt-1">
      <span className="truncate text-[12px] text-faint" title={email}>
        {email}
      </span>
      <button
        onClick={async () => {
          await supabaseBrowser().auth.signOut();
          router.push("/login");
          router.refresh();
        }}
        aria-label="Sign out"
        className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-ink"
      >
        <SignOut size={15} />
      </button>
    </div>
  );
}

export function Sidebar({ email }: { email: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* desktop */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col gap-5 border-r border-edge bg-surface px-3 py-5 md:flex">
        <Brand />
        <SpaceSwitcher />
        <NavLinks />
        <WorkerPill />
        <SignOutButton email={email} />
      </aside>

      {/* mobile top bar */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-edge bg-surface/90 px-4 py-3 backdrop-blur md:hidden">
        <Brand />
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="rounded-md p-2 text-mute hover:bg-raised hover:text-ink"
        >
          <List size={20} />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-overlay" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col gap-5 border-r border-edge bg-surface px-3 py-5">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="rounded-md p-2 text-mute hover:bg-raised hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
            <SpaceSwitcher />
            <NavLinks onNavigate={() => setOpen(false)} />
            <WorkerPill />
            <SignOutButton email={email} />
          </aside>
        </div>
      )}
    </>
  );
}
