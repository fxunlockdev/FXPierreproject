"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowElbowDownRight,
  ClockCountdown,
  Funnel,
  Graph,
  LinkSimpleHorizontal,
  PencilSimple,
  TrashSimple,
} from "@phosphor-icons/react";
import { parseRouteRules, parseRouteSchedule } from "@pierre/core";
import { Badge, HealthDot } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useAccounts,
  useChannels,
  useDeleteRoute,
  useForumTopics,
  useInsertRoute,
  useRoutes,
  useUpdateRoute,
} from "@/lib/queries";
import {
  describeRouteTopics,
  isForum,
  sourceTopicToValue,
  targetTopicToValue,
  topicOptions,
  valueToSourceTopic,
  valueToTargetTopic,
  ALL_TOPICS,
  GENERAL_TOPIC_ID,
} from "@/lib/topics";
import type { ChannelRow, ForumTopicRow, RouteRow } from "@/lib/types";
import { RouteEditor } from "./route-editor";

function routeBadges(route: RouteRow) {
  const rules = parseRouteRules(route.rules);
  const schedule = parseRouteSchedule(route.schedule);
  const badges: { icon: React.ReactNode; label: string }[] = [];
  const filterCount =
    rules.filters.includeKeywords.length +
    rules.filters.excludeKeywords.length +
    (rules.filters.includeRegex ? 1 : 0) +
    (rules.filters.excludeRegex ? 1 : 0) +
    (rules.filters.mediaTypes ? 1 : 0);
  if (filterCount > 0) badges.push({ icon: <Funnel size={11} />, label: `${filterCount} filters` });
  const transforms =
    rules.replacements.length +
    (rules.linkRemoval.urls !== "off" || rules.linkRemoval.mentions || rules.linkRemoval.hashtags ? 1 : 0) +
    (rules.header ? 1 : 0) +
    (rules.footer ? 1 : 0) +
    (rules.signatureStrip ? 1 : 0);
  if (transforms > 0) badges.push({ icon: <PencilSimple size={11} />, label: `${transforms} edits` });
  if (route.delay_seconds > 0)
    badges.push({ icon: <ClockCountdown size={11} />, label: `+${route.delay_seconds}s` });
  if (schedule) badges.push({ icon: <ClockCountdown size={11} />, label: "scheduled" });
  return badges;
}

function RouteLine({
  route,
  receiver,
  master,
  topics,
  onEdit,
}: {
  route: RouteRow;
  receiver: ChannelRow;
  master: ChannelRow;
  topics: ForumTopicRow[] | undefined;
  onEdit: () => void;
}) {
  const update = useUpdateRoute();
  const remove = useDeleteRoute();
  const badges = routeBadges(route);
  const topicSummary = describeRouteTopics(route, master, receiver, topics);

  return (
    <li className="group flex items-center gap-3 py-3">
      <span className={`h-px w-6 shrink-0 ${route.enabled ? "bg-live" : "bg-edge-strong"}`} aria-hidden />
      <HealthDot health={receiver.health} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={`truncate text-[13.5px] font-medium ${route.enabled ? "" : "text-mute line-through decoration-edge-strong"}`}>
            {receiver.title}
          </p>
          <Badge tone={route.mode === "copy" ? "neutral" : "warn"}>{route.mode}</Badge>
          {badges.map((b, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-faint"
            >
              {b.icon}
              {b.label}
            </span>
          ))}
        </div>
        <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
          {topicSummary && <span className="text-mute">{topicSummary} · </span>}
          {receiver.username ? `@${receiver.username}` : "private"} · edits {route.sync_edits ? "on" : "off"} ·
          deletes {route.sync_deletes ? "on" : "off"}
        </p>
      </div>
      <button
        onClick={onEdit}
        aria-label={`Edit route to ${receiver.title}`}
        className="rounded-md p-1.5 text-faint opacity-0 transition-all hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        <PencilSimple size={15} />
      </button>
      <button
        onClick={() => {
          if (window.confirm(`Unlink ${master.title} → ${receiver.title}? Its history is removed too.`)) {
            remove.mutate(route.id, { onSuccess: () => toast.success("Route removed") });
          }
        }}
        aria-label={`Remove route to ${receiver.title}`}
        className="rounded-md p-1.5 text-faint opacity-0 transition-all hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        <TrashSimple size={15} />
      </button>
      <Switch
        checked={route.enabled}
        label={`Route to ${receiver.title}`}
        onCheckedChange={(enabled) => update.mutate({ id: route.id, patch: { enabled } })}
      />
    </li>
  );
}

export default function RoutesPage() {
  const { data: channels, isLoading: loadingChannels } = useChannels();
  const { data: routes, isLoading: loadingRoutes } = useRoutes();
  const { data: accounts } = useAccounts();
  const insert = useInsertRoute();
  const { data: topics } = useForumTopics();

  const masters = useMemo(() => (channels ?? []).filter((c) => c.role === "master"), [channels]);
  const receivers = useMemo(() => (channels ?? []).filter((c) => c.role === "receiver"), [channels]);
  const [selectedMasterId, setSelectedMasterId] = useState<string | null>(null);
  const [linking, setLinking] = useState("");
  const [linkSourceTopic, setLinkSourceTopic] = useState(ALL_TOPICS);
  const [linkTargetTopic, setLinkTargetTopic] = useState(String(GENERAL_TOPIC_ID));
  const [editing, setEditing] = useState<RouteRow | null>(null);

  const activeMasterId = selectedMasterId ?? masters[0]?.id ?? null;
  const activeMaster = masters.find((m) => m.id === activeMasterId) ?? null;
  const masterRoutes = (routes ?? []).filter((r) => r.master_id === activeMasterId);
  const linkedReceiverIds = new Set(masterRoutes.map((r) => r.receiver_id));
  const masterIsForum = isForum(activeMaster ?? undefined, topics);
  // with topics, one pair can be linked several times (one link per topic mapping)
  const unlinked = receivers.filter(
    (r) => !linkedReceiverIds.has(r.id) || masterIsForum || isForum(r, topics),
  );
  const channelById = new Map((channels ?? []).map((c) => [c.id, c]));
  const linkingReceiver = linking ? channelById.get(linking) : undefined;
  const receiverIsForum = isForum(linkingReceiver, topics);

  const loading = loadingChannels || loadingRoutes;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Routes</h1>
        <p className="mt-0.5 text-[13px] text-mute">
          Pick a master on the left, wire its receivers on the right. Everything applies live.
        </p>
      </header>

      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      ) : masters.length === 0 ? (
        <EmptyState
          icon={<Graph size={20} />}
          title="No masters to route from"
          hint="Add a master channel first, then come back to wire its receivers."
          action={
            <Link href="/channels">
              <Button variant="primary" size="sm">
                Go to channels
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* master rail */}
          <nav aria-label="Masters" className="flex flex-col gap-1 lg:border-r lg:border-edge lg:pr-6">
            <p className="mb-1 px-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-faint">
              Masters
            </p>
            {masters.map((m) => {
              const count = (routes ?? []).filter((r) => r.master_id === m.id).length;
              const active = m.id === activeMasterId;
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedMasterId(m.id)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    active ? "bg-raised" : "hover:bg-raised/50"
                  }`}
                >
                  <HealthDot health={m.health} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13.5px] font-medium ${m.enabled ? "" : "text-mute"}`}>
                      {m.title}
                    </span>
                    <span className="block font-mono text-[11px] text-faint">
                      {count} receiver{count === 1 ? "" : "s"}
                    </span>
                  </span>
                  {active && <span className="h-6 w-0.5 rounded-full bg-live" aria-hidden />}
                </button>
              );
            })}
          </nav>

          {/* receiver panel */}
          <section aria-label="Linked receivers">
            {activeMaster && (
              <>
                <div className="mb-4 flex items-center gap-2 text-[13px] text-mute">
                  <span className="font-medium text-ink">{activeMaster.title}</span>
                  <ArrowElbowDownRight size={14} className="text-live" />
                  <span>
                    {masterRoutes.length} linked receiver{masterRoutes.length === 1 ? "" : "s"}
                  </span>
                </div>

                {masterRoutes.length === 0 ? (
                  <EmptyState
                    icon={<LinkSimpleHorizontal size={20} />}
                    title="No receivers linked"
                    hint={`Posts from ${activeMaster.title} go nowhere until you link a receiver below.`}
                  />
                ) : (
                  <ul className="divide-y divide-edge border-y border-edge">
                    {masterRoutes.map((route) => {
                      const receiver = channelById.get(route.receiver_id);
                      if (!receiver) return null;
                      return (
                        <RouteLine
                          key={route.id}
                          route={route}
                          receiver={receiver}
                          master={activeMaster}
                          topics={topics}
                          onEdit={() => setEditing(route)}
                        />
                      );
                    })}
                  </ul>
                )}

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Receiver to link"
                    value={linking}
                    onValueChange={setLinking}
                    placeholder={unlinked.length === 0 ? "All receivers are linked" : "Choose a receiver…"}
                    disabled={unlinked.length === 0}
                    options={unlinked.map((r) => ({ value: r.id, label: r.title }))}
                    className="min-w-56"
                  />
                  {masterIsForum && (
                    <Select
                      aria-label="Relay posts from topic"
                      value={linkSourceTopic}
                      onValueChange={setLinkSourceTopic}
                      options={topicOptions(activeMaster ?? undefined, topics, { includeAll: true }).map((o) => ({
                        ...o,
                        label: o.value === ALL_TOPICS ? "From: all topics" : `From: ${o.label}`,
                      }))}
                      className="min-w-44"
                    />
                  )}
                  {receiverIsForum && (
                    <Select
                      aria-label="Post into topic"
                      value={linkTargetTopic}
                      onValueChange={setLinkTargetTopic}
                      options={topicOptions(linkingReceiver, topics, { includeAll: false }).map((o) => ({
                        ...o,
                        label: `Into: ${o.label}`,
                      }))}
                      className="min-w-44"
                    />
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!linking}
                    loading={insert.isPending}
                    onClick={() => {
                      if (!activeMasterId || !linking) return;
                      const source_topic_id = masterIsForum ? valueToSourceTopic(linkSourceTopic) : null;
                      const target_topic_id = receiverIsForum ? valueToTargetTopic(linkTargetTopic) : null;
                      const duplicate = masterRoutes.some(
                        (r) =>
                          r.receiver_id === linking &&
                          r.source_topic_id === source_topic_id &&
                          r.target_topic_id === target_topic_id,
                      );
                      if (duplicate) {
                        toast.error("That exact link already exists — pick a different topic");
                        return;
                      }
                      insert.mutate(
                        { master_id: activeMasterId, receiver_id: linking, source_topic_id, target_topic_id },
                        {
                          onSuccess: () => {
                            toast.success("Receiver linked — forwarding is live");
                            setLinking("");
                            setLinkSourceTopic(sourceTopicToValue(null));
                            setLinkTargetTopic(targetTopicToValue(null));
                          },
                        },
                      );
                    }}
                  >
                    <LinkSimpleHorizontal size={14} /> Link receiver
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {editing && activeMaster && (
        <RouteEditor
          route={editing}
          master={activeMaster}
          receiver={channelById.get(editing.receiver_id)!}
          accounts={accounts ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
