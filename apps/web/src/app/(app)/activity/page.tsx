"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowCounterClockwise, DownloadSimple, ListChecks } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, stateTone } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { formatLatency, shortTime, timeAgo } from "@/lib/format";
import { useChannels, useForwards, useRoutes } from "@/lib/queries";
import type { ForwardRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";

const STATE_OPTIONS = [
  { value: "all", label: "All states" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "dropped", label: "Dropped" },
  { value: "queued", label: "Queued" },
  { value: "scheduled", label: "Scheduled" },
  { value: "held", label: "Held" },
  { value: "sending", label: "Sending" },
];

const KIND_OPTIONS = [
  { value: "all", label: "All kinds" },
  { value: "post", label: "Posts" },
  { value: "edit", label: "Edits" },
  { value: "delete", label: "Deletes" },
];

function DetailDialog({
  forward,
  masterTitle,
  receiverTitle,
  onClose,
}: {
  forward: ForwardRow;
  masterTitle: string;
  receiverTitle: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await workerCall("forwards/retry", { id: forward.id });
      toast.success("Queued for retry");
      void qc.invalidateQueries({ queryKey: ["forwards"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  const rows: [string, string][] = [
    ["State", forward.state],
    ["Kind", forward.kind],
    ["Master", masterTitle],
    ["Receiver", receiverTitle],
    ["Source message", `#${forward.src_message_id}${forward.album_key ? " (album)" : ""}`],
    ["Media", forward.media_kind ?? "text"],
    ["Created", `${shortTime(forward.created_at)} · ${timeAgo(forward.created_at)}`],
    ["Deliver at", shortTime(forward.deliver_at)],
    ["Attempts", String(forward.attempts)],
    ["Latency", formatLatency(forward.latency_ms)],
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Forward detail" wide>
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</dt>
                <dd className="mt-0.5 text-[13px] text-ink">{value}</dd>
              </div>
            ))}
          </dl>

          {forward.preview && (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Content preview</p>
              <p className="whitespace-pre-wrap rounded-lg border border-edge bg-raised px-3 py-2.5 text-[13px] leading-relaxed text-mute">
                {forward.preview}
              </p>
            </div>
          )}

          {forward.drop_reason && (
            <p className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn">
              Dropped: {forward.drop_reason}
            </p>
          )}
          {forward.last_error && (
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 font-mono text-[12.5px] text-danger">
              {forward.last_error}
            </p>
          )}

          {(forward.state === "failed" || forward.state === "dropped") && (
            <div className="flex justify-end">
              <Button variant="primary" loading={retrying} onClick={retry}>
                <ArrowCounterClockwise size={14} /> Retry now
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function ActivityPage() {
  const [state, setState] = useState("all");
  const [kind, setKind] = useState("all");
  const [routeId, setRouteId] = useState("all");
  const [selected, setSelected] = useState<ForwardRow | null>(null);

  const { data: forwards, isLoading } = useForwards({
    state: state === "all" ? undefined : state,
    kind: kind === "all" ? undefined : kind,
    routeId: routeId === "all" ? undefined : routeId,
  });
  const { data: channels } = useChannels();
  const { data: routes } = useRoutes();

  const channelById = useMemo(() => new Map((channels ?? []).map((c) => [c.id, c])), [channels]);

  const routeOptions = useMemo(
    () => [
      { value: "all", label: "All routes" },
      ...(routes ?? []).map((r) => ({
        value: r.id,
        label: `${channelById.get(r.master_id)?.title ?? "?"} → ${channelById.get(r.receiver_id)?.title ?? "?"}`,
      })),
    ],
    [routes, channelById],
  );

  const exportCsv = () => {
    const rows = forwards ?? [];
    const header = "created_at,kind,state,master,receiver,src_message_id,latency_ms,attempts,error,drop_reason,preview";
    const escape = (v: string) => `"${v.replaceAll('"', '""')}"`;
    const lines = rows.map((f) =>
      [
        f.created_at,
        f.kind,
        f.state,
        channelById.get(f.master_channel_id)?.title ?? "",
        channelById.get(f.receiver_channel_id)?.title ?? "",
        String(f.src_message_id),
        String(f.latency_ms ?? ""),
        String(f.attempts),
        f.last_error ?? "",
        f.drop_reason ?? "",
        f.preview ?? "",
      ]
        .map(escape)
        .join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `switchyard-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-0.5 text-[13px] text-mute">Every forward, edit and delete — live.</p>
        </div>
        <Button size="sm" onClick={exportCsv} disabled={(forwards ?? []).length === 0}>
          <DownloadSimple size={14} /> Export CSV
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        <Select value={state} onValueChange={setState} options={STATE_OPTIONS} className="w-36" />
        <Select value={kind} onValueChange={setKind} options={KIND_OPTIONS} className="w-32" />
        <Select value={routeId} onValueChange={setRouteId} options={routeOptions} className="min-w-52" />
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-1.5">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : (forwards ?? []).length === 0 ? (
        <EmptyState
          icon={<ListChecks size={20} />}
          title="Nothing here yet"
          hint="Forwards matching these filters will appear the moment they happen."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-edge text-[11px] font-medium uppercase tracking-wider text-faint">
                <th className="py-2 pr-4 font-medium">Time</th>
                <th className="py-2 pr-4 font-medium">Route</th>
                <th className="py-2 pr-4 font-medium">Kind</th>
                <th className="py-2 pr-4 font-medium">State</th>
                <th className="py-2 pr-4 text-right font-medium">Latency</th>
                <th className="py-2 font-medium">Content / error</th>
              </tr>
            </thead>
            <tbody>
              {(forwards ?? []).map((f) => (
                <tr
                  key={f.id}
                  onClick={() => setSelected(f)}
                  className="cursor-pointer border-b border-edge/60 transition-colors hover:bg-raised/50"
                >
                  <td className="py-2.5 pr-4 font-mono text-[12px] text-faint" title={f.created_at}>
                    {shortTime(f.created_at)}
                  </td>
                  <td className="max-w-56 truncate py-2.5 pr-4 text-[13px]">
                    {channelById.get(f.master_channel_id)?.title ?? "?"}
                    <span className="text-faint"> → </span>
                    {channelById.get(f.receiver_channel_id)?.title ?? "?"}
                  </td>
                  <td className="py-2.5 pr-4 text-[12.5px] text-mute">{f.kind}</td>
                  <td className="py-2.5 pr-4">
                    <Badge tone={stateTone(f.state)}>{f.state}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-right font-mono text-[12px] text-mute">
                    {formatLatency(f.latency_ms)}
                  </td>
                  <td className="max-w-72 truncate py-2.5 text-[12.5px] text-mute">
                    {f.last_error ? (
                      <span className="text-danger">{f.last_error}</span>
                    ) : f.drop_reason ? (
                      <span className="text-warn">{f.drop_reason}</span>
                    ) : (
                      (f.preview ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <DetailDialog
          forward={selected}
          masterTitle={channelById.get(selected.master_channel_id)?.title ?? "?"}
          receiverTitle={channelById.get(selected.receiver_channel_id)?.title ?? "?"}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
