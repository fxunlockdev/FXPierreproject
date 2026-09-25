"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Stack, TrashSimple } from "@phosphor-icons/react";
import { parseRouteRules, type RouteRules } from "@pierre/core";
import { EmptyState, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { timeAgo } from "@/lib/format";
import {
  useChannels,
  useDeletePreset,
  useInsertPreset,
  usePresets,
  useRoutes,
  useSetRoutePreset,
  useUpdatePreset,
} from "@/lib/queries";
import { useSpace } from "@/lib/space";
import type { ChannelRow, PresetRow, RouteRow } from "@/lib/types";
import { FilterFields, TransformFields } from "../routes/rule-fields";

/** One line describing what a preset does, without opening it. */
function summarize(rules: RouteRules): string {
  const parts: string[] = [];
  const f = rules.filters;
  if (f.excludeKeywords.length > 0) parts.push(`${f.excludeKeywords.length} blocked`);
  if (f.includeKeywords.length > 0) parts.push(`${f.includeKeywords.length} required`);
  if (f.excludeRegex || f.includeRegex) parts.push("patterns");
  if (f.mediaTypes?.length) parts.push(`${f.mediaTypes.length} media types`);
  if (rules.replacements.length > 0) parts.push(`${rules.replacements.length} replacements`);
  if (rules.linkRemoval.urls !== "off") parts.push("links removed");
  if (rules.linkRemoval.mentions) parts.push("no @mentions");
  if (rules.header || rules.footer) parts.push("header/footer");
  return parts.length > 0 ? parts.join(" · ") : "no rules yet";
}

function PresetEditor({ preset, onClose }: { preset: PresetRow; onClose: () => void }) {
  const update = useUpdatePreset();
  const [name, setName] = useState(preset.name);
  const [rules, setRules] = useState<RouteRules>(() => parseRouteRules(preset.rules));
  const patch = (p: Partial<RouteRules>) => setRules((r) => ({ ...r, ...p }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        wide
        title={`Preset: ${preset.name}`}
        description="Saved once, used by every route that follows this preset."
      >
        <div className="flex flex-col gap-5">
          <Field label="Name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Tabs defaultValue="filters">
            <TabsList items={[{ value: "filters", label: "Filters" }, { value: "transforms", label: "Transforms" }]} />
            <TabsContent value="filters">
              <FilterFields rules={rules} onChange={patch} />
            </TabsContent>
            <TabsContent value="transforms">
              <TransformFields rules={rules} onChange={patch} />
            </TabsContent>
          </Tabs>
          <div className="flex justify-end gap-2 border-t border-edge pt-4">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: preset.id, patch: { name: name.trim() || preset.name, rules: rules as unknown } },
                  {
                    onSuccess: () => {
                      toast.success("Preset saved — every route using it follows immediately");
                      onClose();
                    },
                  },
                )
              }
            >
              Save preset
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog({
  preset,
  routes,
  channels,
  onClose,
}: {
  preset: PresetRow;
  routes: RouteRow[];
  channels: ChannelRow[];
  onClose: () => void;
}) {
  const apply = useSetRoutePreset();
  const title = (id: string) => channels.find((c) => c.id === id)?.title ?? "?";
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(routes.filter((r) => r.preset_id === preset.id).map((r) => r.id)),
  );

  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    const add = routes.filter((r) => picked.has(r.id) && r.preset_id !== preset.id).map((r) => r.id);
    const remove = routes.filter((r) => !picked.has(r.id) && r.preset_id === preset.id).map((r) => r.id);
    const done = () => {
      toast.success(`“${preset.name}” now applies to ${picked.size} route${picked.size === 1 ? "" : "s"}`);
      onClose();
    };
    if (add.length === 0 && remove.length === 0) return onClose();
    apply.mutate(
      { routeIds: add, presetId: preset.id },
      {
        onSuccess: () =>
          remove.length > 0
            ? apply.mutate({ routeIds: remove, presetId: null }, { onSuccess: done })
            : done(),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Apply “${preset.name}”`}
        description="Ticked routes run this preset instead of their own rules."
      >
        <div className="flex flex-col gap-4">
          {routes.length === 0 ? (
            <p className="text-[13px] text-mute">No routes yet. Link a master to a receiver first.</p>
          ) : (
            <ul className="max-h-80 divide-y divide-edge overflow-y-auto border-y border-edge">
              {routes.map((r) => {
                const other = r.preset_id && r.preset_id !== preset.id;
                return (
                  <li key={r.id}>
                    <label className="flex cursor-pointer items-center gap-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={picked.has(r.id)}
                        onChange={() => toggle(r.id)}
                        className="size-4 accent-[var(--live)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">
                        {title(r.master_id)} <span className="text-faint">→</span> {title(r.receiver_id)}
                      </span>
                      {other && <span className="shrink-0 text-[11.5px] text-warn">another preset</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={apply.isPending} onClick={save} disabled={routes.length === 0}>
              Apply to {picked.size} route{picked.size === 1 ? "" : "s"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PresetsPage() {
  const { canEdit } = useSpace();
  const { data: presets, isLoading } = usePresets();
  const { data: routes } = useRoutes();
  const { data: channels } = useChannels();
  const create = useInsertPreset();
  const remove = useDeletePreset();
  const [editing, setEditing] = useState<PresetRow | null>(null);
  const [applying, setApplying] = useState<PresetRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const usedBy = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of routes ?? []) {
      if (r.preset_id) counts.set(r.preset_id, (counts.get(r.preset_id) ?? 0) + 1);
    }
    return counts;
  }, [routes]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Presets</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-mute">
          One set of filters and transforms, shared by as many routes as you like. Edit a preset once and
          every route following it changes with it.
        </p>
      </header>

      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(
              { name: newName.trim(), rules: {} },
              {
                onSuccess: (preset) => {
                  setNewName("");
                  setEditing(preset);
                },
              },
            );
          }}
        >
          <Field label="New preset" className="min-w-56 flex-1" hint="For example “House rules” or “No promos”.">
            <Input required value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} placeholder="House rules" />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending}>
            <Plus size={14} weight="bold" /> Create preset
          </Button>
        </form>
      )}

      {isLoading ? (
        <Skeleton className="h-40" />
      ) : (presets ?? []).length === 0 ? (
        <EmptyState
          icon={<Stack size={20} />}
          title="No presets yet"
          hint="Create one, add the words to block, then apply it to every route that needs it."
        />
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {(presets ?? []).map((p) => {
            const count = usedBy.get(p.id) ?? 0;
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium">{p.name}</p>
                  <p className="truncate text-[12.5px] text-mute">
                    {summarize(parseRouteRules(p.rules))} · used by {count} route{count === 1 ? "" : "s"} ·
                    edited {timeAgo(p.updated_at)}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" onClick={() => setEditing(p)}>
                      Edit rules
                    </Button>
                    <Button size="sm" onClick={() => setApplying(p)}>
                      Apply to routes
                    </Button>
                    {confirmDelete === p.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="danger"
                          loading={remove.isPending}
                          onClick={() =>
                            remove.mutate(p.id, {
                              onSuccess: () => {
                                toast.success(`“${p.name}” deleted — its routes use their own rules again`);
                                setConfirmDelete(null);
                              },
                            })
                          }
                        >
                          Delete
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(p.id)}
                        aria-label={`Delete ${p.name}`}
                        className="rounded-md p-1.5 text-faint transition-colors hover:bg-danger-soft hover:text-danger"
                      >
                        <TrashSimple size={15} />
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editing && <PresetEditor preset={editing} onClose={() => setEditing(null)} />}
      {applying && (
        <ApplyDialog
          preset={applying}
          routes={routes ?? []}
          channels={channels ?? []}
          onClose={() => setApplying(null)}
        />
      )}
    </div>
  );
}
