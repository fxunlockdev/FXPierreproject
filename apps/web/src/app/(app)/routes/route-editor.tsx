"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Flask, Plus, TrashSimple } from "@phosphor-icons/react";
import {
  applyRules,
  parseRouteRules,
  parseRouteSchedule,
  resolveTiming,
  richText,
  type Entity,
  type MediaKind,
  type RouteRules,
  type RouteSchedule,
} from "@pierre/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { useForumTopics, useUpdateRoute } from "@/lib/queries";
import {
  isForum,
  sourceTopicToValue,
  targetTopicToValue,
  topicOptions,
  valueToSourceTopic,
  valueToTargetTopic,
} from "@/lib/topics";
import { useNow } from "@/lib/use-now";
import type { AccountRow, ChannelRow, RouteRow } from "@/lib/types";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MEDIA_OPTIONS: MediaKind[] = ["text", "photo", "video", "animation", "document", "audio", "voice", "sticker", "poll"];

const COMMON_TZ = [
  "UTC",
  "Europe/Paris",
  "Europe/London",
  "Europe/Zurich",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
];

interface EditorState {
  mode: "copy" | "forward";
  silent: boolean;
  sender_account_id: string | null;
  use_fanout: boolean;
  delay_seconds: number;
  sync_edits: boolean;
  sync_deletes: boolean;
  rules: RouteRules;
  scheduleEnabled: boolean;
  schedule: RouteSchedule;
  source_topic_id: number | null;
  target_topic_id: number | null;
}

function SwitchRow({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[13.5px] font-medium">{title}</p>
        <p className="text-[12.5px] text-mute">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

/** Rich-text preview: renders bold/italic/code/link entities inline. */
function RichPreview({ text, entities }: { text: string; entities: Entity[] }) {
  const segments: { text: string; entity?: Entity }[] = [];
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const e of sorted) {
    if (e.offset < cursor) continue; // skip overlapping for display
    if (e.offset > cursor) segments.push({ text: text.slice(cursor, e.offset) });
    segments.push({ text: text.slice(e.offset, e.offset + e.length), entity: e });
    cursor = e.offset + e.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });

  return (
    <p className="whitespace-pre-wrap rounded-lg border border-edge bg-raised px-3.5 py-3 text-[13.5px] leading-relaxed">
      {segments.map((s, i) => {
        if (!s.entity) return <span key={i}>{s.text}</span>;
        switch (s.entity.type) {
          case "bold":
            return <strong key={i}>{s.text}</strong>;
          case "italic":
            return <em key={i}>{s.text}</em>;
          case "code":
          case "pre":
            return (
              <code key={i} className="rounded bg-surface px-1 font-mono text-[12.5px]">
                {s.text}
              </code>
            );
          case "text_link":
          case "url":
            return (
              <span key={i} className="text-live underline underline-offset-2">
                {s.text}
              </span>
            );
          default:
            return <span key={i}>{s.text}</span>;
        }
      })}
    </p>
  );
}

function TestTab({ state, masterTitle }: { state: EditorState; masterTitle: string }) {
  const [sample, setSample] = useState("EURUSD BUY NOW 🔥\nEntry 1.0850\nTP1 1.0900\nSL 1.0800\n\nJoin https://t.me/somechannel");
  const [media, setMedia] = useState<MediaKind>("text");

  const now = useNow(60_000);
  const result = useMemo(() => {
    const msg = {
      chatId: "-100000",
      messageId: 1,
      date: Math.floor(now / 1000),
      media,
      text: richText(sample),
    };
    const content = applyRules(msg, state.rules, {
      masterTitle,
      masterUsername: "master_channel",
      messageLink: "https://t.me/master_channel/1",
    });
    const timing = resolveTiming(
      new Date(now),
      state.delay_seconds,
      state.scheduleEnabled ? state.schedule : null,
      null,
    );
    return { content, timing };
  }, [sample, media, state, masterTitle, now]);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Paste a sample message" hint="Runs through this route's filters and transforms exactly like the relay would.">
        <Textarea rows={6} value={sample} onChange={(e) => setSample(e.target.value)} className="font-mono text-[13px]" />
      </Field>
      <Field label="Media type">
        <Select
          value={media}
          onValueChange={(v) => setMedia(v as MediaKind)}
          options={MEDIA_OPTIONS.map((m) => ({ value: m, label: m }))}
          className="w-40"
        />
      </Field>

      <div className="border-t border-edge pt-4">
        {result.content.action === "drop" ? (
          <div className="flex items-center gap-2.5">
            <Badge tone="warn">dropped</Badge>
            <p className="text-[13px] text-mute">{result.content.reason}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone="live">passes</Badge>
              {result.timing.action === "send" && <p className="text-[13px] text-mute">would send immediately</p>}
              {result.timing.action === "schedule" && (
                <p className="text-[13px] text-mute">
                  would send {result.timing.held ? "when the schedule window opens" : "after the delay"} —{" "}
                  {result.timing.deliverAt.toLocaleString()}
                </p>
              )}
              {result.timing.action === "drop" && (
                <p className="text-[13px] text-warn">would be dropped: {result.timing.reason}</p>
              )}
            </div>
            <RichPreview text={result.content.output.text} entities={result.content.output.entities} />
          </div>
        )}
      </div>
    </div>
  );
}

export function RouteEditor({
  route,
  master,
  receiver,
  accounts,
  onClose,
}: {
  route: RouteRow;
  master: ChannelRow;
  receiver: ChannelRow;
  accounts: AccountRow[];
  onClose: () => void;
}) {
  const update = useUpdateRoute();
  const { data: topics } = useForumTopics();
  const masterIsForum = isForum(master, topics);
  const receiverIsForum = isForum(receiver, topics);
  const [state, setState] = useState<EditorState>(() => {
    const schedule = parseRouteSchedule(route.schedule);
    return {
      mode: route.mode,
      silent: route.silent,
      sender_account_id: route.sender_account_id,
      use_fanout: route.use_fanout,
      delay_seconds: route.delay_seconds,
      sync_edits: route.sync_edits,
      sync_deletes: route.sync_deletes,
      rules: parseRouteRules(route.rules),
      scheduleEnabled: schedule !== null,
      schedule: schedule ?? { tz: "UTC", windows: [], offWindow: "hold" },
      source_topic_id: route.source_topic_id,
      target_topic_id: route.target_topic_id,
    };
  });

  const set = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    setState((s) => ({ ...s, [key]: value }));
  const setRules = (patch: Partial<RouteRules>) => setState((s) => ({ ...s, rules: { ...s.rules, ...patch } }));
  const setFilters = (patch: Partial<RouteRules["filters"]>) =>
    setState((s) => ({ ...s, rules: { ...s.rules, filters: { ...s.rules.filters, ...patch } } }));
  const setLinks = (patch: Partial<RouteRules["linkRemoval"]>) =>
    setState((s) => ({ ...s, rules: { ...s.rules, linkRemoval: { ...s.rules.linkRemoval, ...patch } } }));

  const save = () => {
    update.mutate(
      {
        id: route.id,
        patch: {
          mode: state.mode,
          silent: state.silent,
          sender_account_id: state.sender_account_id,
          use_fanout: state.use_fanout,
          delay_seconds: state.delay_seconds,
          sync_edits: state.sync_edits,
          sync_deletes: state.sync_deletes,
          rules: state.rules as unknown,
          schedule: state.scheduleEnabled && state.schedule.windows.length > 0 ? (state.schedule as unknown) : null,
          source_topic_id: masterIsForum ? state.source_topic_id : null,
          target_topic_id: receiverIsForum ? state.target_topic_id : null,
        },
      },
      {
        onSuccess: () => {
          toast.success("Route saved — live immediately");
          onClose();
        },
      },
    );
  };

  const senderOptions = [
    { value: "auto", label: "Automatic — share the load across bots" },
    ...accounts
      .filter((a) => a.is_sender)
      .map((a) => ({ value: a.id, label: `${a.label} (${a.kind})` })),
  ];

  const keywordsToText = (list: string[]) => list.join("\n");
  const textToKeywords = (text: string) =>
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        wide
        title={`${master.title} → ${receiver.title}`}
        description="Changes apply instantly — no restart needed."
      >
        <Tabs defaultValue="general">
          <TabsList
            items={[
              { value: "general", label: "General" },
              { value: "filters", label: "Filters" },
              { value: "transforms", label: "Transforms" },
              { value: "schedule", label: "Schedule" },
              { value: "test", label: "Test" },
            ]}
          />

          <TabsContent value="general" className="flex flex-col divide-y divide-edge">
            <div className="grid gap-4 pb-4 sm:grid-cols-2">
              <Field label="Mode" hint='Copy looks like an original post; Forward keeps the "Forwarded from" header.'>
                <Select
                  value={state.mode}
                  onValueChange={(v) => set("mode", v as "copy" | "forward")}
                  options={[
                    { value: "copy", label: "Copy (recommended)" },
                    { value: "forward", label: "Forward with header" },
                  ]}
                />
              </Field>
              <Field label="Sender" hint="Which account posts to the receiver.">
                <Select
                  value={state.sender_account_id ?? "auto"}
                  onValueChange={(v) => set("sender_account_id", v === "auto" ? null : v)}
                  options={senderOptions}
                />
              </Field>
              {masterIsForum && (
                <Field
                  label="From topic"
                  hint="Relay only posts made in this topic of the master. Topics appear here once someone posts in them."
                >
                  <Select
                    value={sourceTopicToValue(state.source_topic_id)}
                    onValueChange={(v) => set("source_topic_id", valueToSourceTopic(v))}
                    options={topicOptions(master, topics, { includeAll: true })}
                  />
                </Field>
              )}
              {receiverIsForum && (
                <Field label="Into topic" hint="Which topic of the receiver the posts land in.">
                  <Select
                    value={targetTopicToValue(state.target_topic_id)}
                    onValueChange={(v) => set("target_topic_id", valueToTargetTopic(v))}
                    options={topicOptions(receiver, topics, { includeAll: false })}
                  />
                </Field>
              )}
            </div>
            <SwitchRow
              title="Silent delivery"
              hint="Receiver members get the post without a notification sound."
              checked={state.silent}
              onChange={(v) => set("silent", v)}
            />
            <SwitchRow
              title="Bot fan-out"
              hint="Route media through the buffer channel so a bot can deliver at full speed."
              checked={state.use_fanout}
              onChange={(v) => set("use_fanout", v)}
            />
            <SwitchRow
              title="Sync edits"
              hint="When the master edits a post, update the receiver copy. Copy mode only."
              checked={state.sync_edits}
              onChange={(v) => set("sync_edits", v)}
              disabled={state.mode === "forward"}
            />
            <SwitchRow
              title="Sync deletes"
              hint="When the master deletes a post, delete the receiver copy. Copy mode only. Needs a connected Telegram user account — Telegram never tells bots about deletions."
              checked={state.sync_deletes}
              onChange={(v) => set("sync_deletes", v)}
              disabled={state.mode === "forward"}
            />
          </TabsContent>

          <TabsContent value="filters" className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Must contain (one per line)" hint="Empty = everything passes.">
                <Textarea
                  rows={4}
                  value={keywordsToText(state.rules.filters.includeKeywords)}
                  onChange={(e) => setFilters({ includeKeywords: textToKeywords(e.target.value) })}
                  placeholder={"EURUSD\nXAUUSD"}
                />
              </Field>
              <Field label="Must NOT contain (one per line)">
                <Textarea
                  rows={4}
                  value={keywordsToText(state.rules.filters.excludeKeywords)}
                  onChange={(e) => setFilters({ excludeKeywords: textToKeywords(e.target.value) })}
                  placeholder={"promo\ngiveaway"}
                />
              </Field>
              <Field label="Required pattern (regex)" hint="Optional. e.g. TP\d">
                <Input
                  value={state.rules.filters.includeRegex ?? ""}
                  onChange={(e) => setFilters({ includeRegex: e.target.value || undefined })}
                  className="font-mono"
                />
              </Field>
              <Field label="Blocked pattern (regex)">
                <Input
                  value={state.rules.filters.excludeRegex ?? ""}
                  onChange={(e) => setFilters({ excludeRegex: e.target.value || undefined })}
                  className="font-mono"
                />
              </Field>
            </div>
            <div className="flex flex-col divide-y divide-edge border-y border-edge">
              <SwitchRow
                title="Case sensitive"
                hint="Match keyword capitalization exactly."
                checked={state.rules.filters.caseSensitive}
                onChange={(v) => setFilters({ caseSensitive: v })}
              />
              <SwitchRow
                title="Whole words only"
                hint='"buy" will not match "buyer".'
                checked={state.rules.filters.wholeWord}
                onChange={(v) => setFilters({ wholeWord: v })}
              />
            </div>
            <Field label="Allowed media types" hint="Nothing selected = all types pass.">
              <div className="flex flex-wrap gap-1.5">
                {MEDIA_OPTIONS.map((m) => {
                  const active = state.rules.filters.mediaTypes?.includes(m) ?? false;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        const current = state.rules.filters.mediaTypes ?? [];
                        const next = active ? current.filter((x) => x !== m) : [...current, m];
                        setFilters({ mediaTypes: next.length > 0 ? next : undefined });
                      }}
                      className={`rounded-md border px-2.5 py-1 text-[12.5px] transition-colors ${
                        active
                          ? "border-live/40 bg-live-soft text-live"
                          : "border-edge text-mute hover:border-edge-strong hover:text-ink"
                      }`}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Min length (chars)">
                <Input
                  type="number"
                  min={0}
                  value={state.rules.filters.minLength ?? ""}
                  onChange={(e) => setFilters({ minLength: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </Field>
              <Field label="Max length (chars)">
                <Input
                  type="number"
                  min={0}
                  value={state.rules.filters.maxLength ?? ""}
                  onChange={(e) => setFilters({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </Field>
            </div>
          </TabsContent>

          <TabsContent value="transforms" className="flex flex-col gap-5">
            <div>
              <p className="mb-2 text-[13px] font-medium text-mute">Find & replace (runs in order)</p>
              <div className="flex flex-col gap-2">
                {state.rules.replacements.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={r.find}
                      onChange={(e) => {
                        const next = [...state.rules.replacements];
                        next[i] = { ...r, find: e.target.value };
                        setRules({ replacements: next });
                      }}
                      placeholder="find"
                      className="flex-1 font-mono text-[13px]"
                    />
                    <span className="text-faint">→</span>
                    <Input
                      value={r.replace}
                      onChange={(e) => {
                        const next = [...state.rules.replacements];
                        next[i] = { ...r, replace: e.target.value };
                        setRules({ replacements: next });
                      }}
                      placeholder="replace with"
                      className="flex-1 font-mono text-[13px]"
                    />
                    <button
                      type="button"
                      title="Regex"
                      onClick={() => {
                        const next = [...state.rules.replacements];
                        next[i] = { ...r, regex: !r.regex };
                        setRules({ replacements: next });
                      }}
                      className={`rounded-md border px-1.5 py-1 font-mono text-[11px] ${
                        r.regex ? "border-live/40 bg-live-soft text-live" : "border-edge text-faint"
                      }`}
                    >
                      .*
                    </button>
                    <div className="flex flex-col">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={() => {
                          const next = [...state.rules.replacements];
                          [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                          setRules({ replacements: next });
                        }}
                        className="text-faint hover:text-ink disabled:opacity-30"
                      >
                        <ArrowUp size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={i === state.rules.replacements.length - 1}
                        onClick={() => {
                          const next = [...state.rules.replacements];
                          [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                          setRules({ replacements: next });
                        }}
                        className="text-faint hover:text-ink disabled:opacity-30"
                      >
                        <ArrowDown size={11} />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove rule"
                      onClick={() => setRules({ replacements: state.rules.replacements.filter((_, x) => x !== i) })}
                      className="rounded-md p-1.5 text-faint hover:bg-danger-soft hover:text-danger"
                    >
                      <TrashSimple size={14} />
                    </button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    setRules({
                      replacements: [
                        ...state.rules.replacements,
                        { find: "", replace: "", regex: false, caseSensitive: false },
                      ],
                    })
                  }
                >
                  <Plus size={13} /> Add replacement
                </Button>
              </div>
            </div>

            <div className="border-t border-edge pt-4">
              <p className="mb-2 text-[13px] font-medium text-mute">Link & mention removal</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="URLs">
                  <Select
                    value={state.rules.linkRemoval.urls}
                    onValueChange={(v) => setLinks({ urls: v as "off" | "tme" | "all" })}
                    options={[
                      { value: "off", label: "Keep all links" },
                      { value: "tme", label: "Remove Telegram links only" },
                      { value: "all", label: "Remove every link" },
                    ]}
                  />
                </Field>
                <Field label="Replace removed links with" hint="Leave empty to just delete them.">
                  <Input
                    value={state.rules.linkRemoval.placeholder}
                    onChange={(e) => setLinks({ placeholder: e.target.value })}
                    placeholder="[link removed]"
                  />
                </Field>
              </div>
              <div className="mt-2 flex flex-col divide-y divide-edge border-y border-edge">
                <SwitchRow
                  title="Strip @mentions"
                  hint="Removes @usernames from the text."
                  checked={state.rules.linkRemoval.mentions}
                  onChange={(v) => setLinks({ mentions: v })}
                />
                <SwitchRow
                  title="Strip #hashtags"
                  hint="Removes hashtags from the text."
                  checked={state.rules.linkRemoval.hashtags}
                  onChange={(v) => setLinks({ hashtags: v })}
                />
                <SwitchRow
                  title="Drop inline buttons"
                  hint="Posts are delivered without the source's buttons."
                  checked={state.rules.linkRemoval.buttons}
                  onChange={(v) => setLinks({ buttons: v })}
                />
              </div>
            </div>

            <div className="grid gap-4 border-t border-edge pt-4 sm:grid-cols-2">
              <Field
                label="Header"
                hint="Added above each post. **bold** __italic__ [link](url) {master} {date} {time} {link}"
              >
                <Textarea
                  rows={2}
                  value={state.rules.header}
                  onChange={(e) => setRules({ header: e.target.value })}
                  placeholder="**{master}**"
                />
              </Field>
              <Field label="Footer" hint="Added below each post — same formatting and variables.">
                <Textarea
                  rows={2}
                  value={state.rules.footer}
                  onChange={(e) => setRules({ footer: e.target.value })}
                  placeholder="__relayed {time}__"
                />
              </Field>
            </div>
            <Field label="Strip source signature (regex)" hint="Removes a matching block from the END of each post, e.g. — VIP Team.*">
              <Input
                value={state.rules.signatureStrip}
                onChange={(e) => setRules({ signatureStrip: e.target.value })}
                className="font-mono"
              />
            </Field>
          </TabsContent>

          <TabsContent value="schedule" className="flex flex-col gap-4">
            <Field label="Delay (seconds)" hint="Wait this long before every post. 0 = instant.">
              <Input
                type="number"
                min={0}
                max={86400}
                value={state.delay_seconds}
                onChange={(e) => set("delay_seconds", Number(e.target.value))}
                className="w-32"
              />
            </Field>

            <div className="border-t border-edge pt-3">
              <SwitchRow
                title="Weekly schedule"
                hint="Only relay inside chosen time windows."
                checked={state.scheduleEnabled}
                onChange={(v) => set("scheduleEnabled", v)}
              />
            </div>

            {state.scheduleEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Timezone">
                    <Input
                      list="tz-list"
                      value={state.schedule.tz}
                      onChange={(e) => set("schedule", { ...state.schedule, tz: e.target.value })}
                    />
                    <datalist id="tz-list">
                      {COMMON_TZ.map((tz) => (
                        <option key={tz} value={tz} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label="Outside the window">
                    <Select
                      value={state.schedule.offWindow}
                      onValueChange={(v) =>
                        set("schedule", { ...state.schedule, offWindow: v as "hold" | "drop" })
                      }
                      options={[
                        { value: "hold", label: "Hold and send when it opens" },
                        { value: "drop", label: "Drop the message" },
                      ]}
                    />
                  </Field>
                </div>

                <div className="flex flex-col gap-2">
                  {state.schedule.windows.map((w, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Select
                        value={String(w.dow)}
                        onValueChange={(v) => {
                          const windows = [...state.schedule.windows];
                          windows[i] = { ...w, dow: Number(v) };
                          set("schedule", { ...state.schedule, windows });
                        }}
                        options={DOW.map((d, idx) => ({ value: String(idx), label: d }))}
                        className="w-24"
                      />
                      <Input
                        type="time"
                        value={w.start}
                        onChange={(e) => {
                          const windows = [...state.schedule.windows];
                          windows[i] = { ...w, start: e.target.value };
                          set("schedule", { ...state.schedule, windows });
                        }}
                        className="w-28 font-mono"
                      />
                      <span className="text-faint">–</span>
                      <Input
                        type="time"
                        value={w.end}
                        onChange={(e) => {
                          const windows = [...state.schedule.windows];
                          windows[i] = { ...w, end: e.target.value };
                          set("schedule", { ...state.schedule, windows });
                        }}
                        className="w-28 font-mono"
                      />
                      <button
                        type="button"
                        aria-label="Remove window"
                        onClick={() =>
                          set("schedule", {
                            ...state.schedule,
                            windows: state.schedule.windows.filter((_, x) => x !== i),
                          })
                        }
                        className="rounded-md p-1.5 text-faint hover:bg-danger-soft hover:text-danger"
                      >
                        <TrashSimple size={14} />
                      </button>
                    </div>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() =>
                      set("schedule", {
                        ...state.schedule,
                        windows: [...state.schedule.windows, { dow: 1, start: "08:00", end: "18:00" }],
                      })
                    }
                  >
                    <Plus size={13} /> Add window
                  </Button>
                </div>

                <Field
                  label="Drop held posts older than (minutes)"
                  hint="Signals lose value fast — avoid posting stale ones when a window opens. Empty = keep everything."
                >
                  <Input
                    type="number"
                    min={1}
                    value={state.schedule.dropHeldAfterMinutes ?? ""}
                    onChange={(e) =>
                      set("schedule", {
                        ...state.schedule,
                        dropHeldAfterMinutes: e.target.value === "" ? undefined : Number(e.target.value),
                      })
                    }
                    className="w-32"
                  />
                </Field>
              </>
            )}
          </TabsContent>

          <TabsContent value="test">
            <TestTab state={state} masterTitle={master.title} />
          </TabsContent>
        </Tabs>

        <div className="mt-6 flex items-center justify-between gap-2 border-t border-edge pt-4">
          <span className="flex items-center gap-1.5 text-[12px] text-faint">
            <Flask size={13} /> Use the Test tab before saving
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={update.isPending} onClick={save}>
              Save route
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
