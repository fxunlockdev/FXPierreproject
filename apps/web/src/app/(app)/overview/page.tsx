"use client";

import Link from "next/link";
import { ArrowRight, Pulse, Warning } from "@phosphor-icons/react";
import { EmptyState, SectionHeader, Skeleton, Stat } from "@/components/ui/bits";
import { Badge, stateTone } from "@/components/ui/badge";
import { formatLatency, percent, timeAgo } from "@/lib/format";
import {
  useChannels,
  useForwards,
  useForwardsToday,
  useIncidents,
  useRoutes,
  useWorkerStatus,
} from "@/lib/queries";
import { INCIDENT_LABELS } from "@/lib/types";

/** 24 hourly bars, sent vs failed — hand-drawn, no chart library. */
function ActivityChart({
  rows,
}: {
  rows: { state: string; created_at: string }[];
}) {
  const now = new Date();
  const hours: { sent: number; failed: number; label: string }[] = [];
  for (let i = 23; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 3600_000);
    hours.push({ sent: 0, failed: 0, label: `${String(d.getHours()).padStart(2, "0")}:00` });
  }
  for (const row of rows) {
    const age = now.getTime() - new Date(row.created_at).getTime();
    const idx = 23 - Math.floor(age / 3600_000);
    const bucket = hours[idx];
    if (!bucket) continue;
    if (row.state === "failed") bucket.failed += 1;
    else if (row.state === "done") bucket.sent += 1;
  }
  const max = Math.max(1, ...hours.map((h) => h.sent + h.failed));

  return (
    <div>
      <div className="flex h-32 items-end gap-[3px]">
        {hours.map((h, i) => {
          const total = h.sent + h.failed;
          return (
            <div
              key={i}
              className="group relative flex flex-1 flex-col justify-end gap-px"
              title={`${h.label} — ${h.sent} sent, ${h.failed} failed`}
            >
              {h.failed > 0 && (
                <div className="rounded-sm bg-danger/70" style={{ height: `${(h.failed / max) * 112}px` }} />
              )}
              <div
                className={`rounded-sm ${total > 0 ? "bg-live/80" : "bg-edge"} transition-colors group-hover:bg-live`}
                style={{ height: `${Math.max(2, (h.sent / max) * 112)}px` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] uppercase tracking-wider text-faint">
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const { data: today, isLoading: loadingToday } = useForwardsToday();
  const { data: recent } = useForwards({}, 8);
  const { data: incidents } = useIncidents();
  const { data: workers } = useWorkerStatus();
  const { data: routes } = useRoutes();
  const { data: channels } = useChannels();

  const posts = (today ?? []).filter((f) => f.kind === "post");
  const done = posts.filter((f) => f.state === "done");
  const failed = posts.filter((f) => f.state === "failed");
  const attempted = done.length + failed.length;
  const latencies = done.map((f) => f.latency_ms ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  const median = latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null;
  const queueDepth = workers?.reduce((sum, w) => sum + w.queue_depth, 0) ?? 0;
  const open = (incidents ?? []).filter((i) => i.status === "open");
  const channelById = new Map((channels ?? []).map((c) => [c.id, c]));

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-0.5 text-[13px] text-mute">
          {routes?.filter((r) => r.enabled).length ?? "—"} active routes across{" "}
          {channels?.filter((c) => c.role === "master").length ?? "—"} masters
        </p>
      </header>

      {loadingToday ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="grid grid-cols-2 divide-edge border-y border-edge sm:grid-cols-3 sm:divide-x lg:grid-cols-5">
          <Stat label="Forwards today" value={String(done.length)} />
          <Stat
            label="Success rate"
            value={percent(done.length, attempted)}
            tone={attempted > 0 && failed.length / attempted > 0.05 ? "warn" : "live"}
          />
          <Stat label="Median latency" value={formatLatency(median)} />
          <Stat
            label="Failures"
            value={String(failed.length)}
            tone={failed.length > 0 ? "danger" : undefined}
          />
          <Stat label="In queue" value={String(queueDepth)} sub="pending + scheduled" />
        </div>
      )}

      <section>
        <SectionHeader title="Last 24 hours" hint="Delivered forwards per hour; red is failures." />
        <ActivityChart rows={today ?? []} />
      </section>

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <SectionHeader
            title="Needs attention"
            action={
              open.length > 0 && (
                <Link href="/alerts" className="flex items-center gap-1 text-[13px] text-mute hover:text-ink">
                  All alerts <ArrowRight size={13} />
                </Link>
              )
            }
          />
          {open.length === 0 ? (
            <EmptyState
              icon={<Pulse size={20} />}
              title="All clear"
              hint="No open incidents. Failures, permission problems and downtime will surface here."
            />
          ) : (
            <ul className="divide-y divide-edge border-y border-edge">
              {open.slice(0, 5).map((i) => (
                <li key={i.id} className="flex items-start gap-3 py-3">
                  <Warning size={16} className="mt-0.5 shrink-0 text-danger" weight="fill" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium">{INCIDENT_LABELS[i.kind] ?? i.kind}</p>
                    <p className="mt-0.5 truncate text-[13px] text-mute">{i.message}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-faint">{timeAgo(i.last_seen)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionHeader
            title="Live feed"
            action={
              <Link href="/activity" className="flex items-center gap-1 text-[13px] text-mute hover:text-ink">
                Full log <ArrowRight size={13} />
              </Link>
            }
          />
          {(recent ?? []).length === 0 ? (
            <EmptyState
              icon={<Pulse size={20} />}
              title="Waiting for the first forward"
              hint="As soon as a master posts, deliveries appear here in real time."
            />
          ) : (
            <ul className="divide-y divide-edge border-y border-edge">
              {(recent ?? []).map((f) => {
                const master = channelById.get(f.master_channel_id);
                const receiver = channelById.get(f.receiver_channel_id);
                return (
                  <li key={f.id} className="flex items-center gap-3 py-2.5">
                    <Badge tone={stateTone(f.state)}>{f.state}</Badge>
                    <p className="min-w-0 flex-1 truncate text-[13px] text-mute">
                      <span className="text-ink">{master?.title ?? "?"}</span>
                      {" → "}
                      <span className="text-ink">{receiver?.title ?? "?"}</span>
                      {f.preview ? ` · ${f.preview}` : ""}
                    </p>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{timeAgo(f.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
