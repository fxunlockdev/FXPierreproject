"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle, Circle } from "@phosphor-icons/react";
import { useAccounts, useChannels, useRoutes } from "@/lib/queries";
import { useSpace } from "@/lib/space";

interface Step {
  done: boolean;
  title: string;
  hint: string;
  href: string;
  cta: string;
}

/** Shown in a fresh space until the first route exists. */
export function SetupChecklist() {
  const { space, canEdit } = useSpace();
  const { data: accounts, isLoading: la } = useAccounts();
  const { data: channels, isLoading: lc } = useChannels();
  const { data: routes, isLoading: lr } = useRoutes();
  if (la || lc || lr) return null;

  const hasBot = (accounts ?? []).some((a) => a.status === "connected");
  const hasMaster = (channels ?? []).some((c) => c.role === "master");
  const hasReceiver = (channels ?? []).some((c) => c.role === "receiver");
  const hasRoute = (routes ?? []).length > 0;
  if (hasBot && hasMaster && hasReceiver && hasRoute) return null;

  const steps: Step[] = [
    {
      done: hasBot,
      title: "Connect your bot",
      hint: "Create a bot in @BotFather, paste its token, and add the bot as an admin in your channels or groups.",
      href: "/accounts",
      cta: "Accounts",
    },
    {
      done: hasMaster && hasReceiver,
      title: "Add a master and a receiver",
      hint: "The master is where posts come from; receivers are where they get relayed.",
      href: "/channels",
      cta: "Channels",
    },
    {
      done: hasRoute,
      title: "Link them with a route",
      hint: "Pick which receivers each master feeds, plus optional filters, delays and edits sync.",
      href: "/routes",
      cta: "Routes",
    },
  ];
  const next = steps.find((s) => !s.done);

  return (
    <section
      aria-labelledby="setup-heading"
      className="relative overflow-hidden rounded-2xl border border-edge bg-surface p-6"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-live/10 blur-3xl"
      />
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-live">Getting started</p>
      <h2 id="setup-heading" className="mt-1 text-lg font-semibold tracking-tight">
        Welcome to {space.name}
      </h2>
      <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-mute">
        This space is private — only you and the teammates you invite can see its bots, channels and
        logs. Three steps and your first post relays.
      </p>
      {!canEdit && (
        <p className="mt-2 text-[12.5px] text-warn">You have view access — ask a space admin to finish setup.</p>
      )}
      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => (
          <li
            key={s.title}
            className={`flex flex-col gap-2 rounded-xl border p-4 transition-colors ${
              s === next ? "border-live/40 bg-live-soft/30" : "border-edge bg-raised/40"
            }`}
          >
            <div className="flex items-center gap-2">
              {s.done ? (
                <CheckCircle size={18} weight="fill" className="text-live" />
              ) : (
                <Circle size={18} className="text-faint" />
              )}
              <span className="font-mono text-[11px] text-faint">0{i + 1}</span>
              <span className={`text-[13.5px] font-medium ${s.done ? "text-mute line-through" : ""}`}>{s.title}</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-mute">{s.hint}</p>
            {!s.done && canEdit && (
              <Link
                href={s.href}
                className="mt-auto flex items-center gap-1 text-[13px] font-medium text-live hover:underline"
              >
                Open {s.cta} <ArrowRight size={13} />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
