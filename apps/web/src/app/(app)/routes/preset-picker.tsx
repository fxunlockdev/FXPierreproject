"use client";

import Link from "next/link";
import { ArrowSquareOut, Stack } from "@phosphor-icons/react";
import { parseRouteRules, type RouteRules } from "@pierre/core";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { usePresets } from "@/lib/queries";

const OWN_RULES = "own";

/**
 * Which rules this route runs: its own, or a preset shared with other routes.
 * Editing the preset (on the Presets page) changes every route that follows it.
 */
export function PresetPicker({
  presetId,
  onChange,
  onDetach,
}: {
  presetId: string | null;
  onChange: (presetId: string | null) => void;
  /** Copy the preset's rules into this route and stop following it. */
  onDetach: (rules: RouteRules) => void;
}) {
  const { data: presets } = usePresets();
  const preset = (presets ?? []).find((p) => p.id === presetId);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-edge bg-raised/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Stack size={15} className="text-faint" />
        <span className="text-[13px] font-medium">Rules</span>
        <Select
          aria-label="Rules preset"
          value={presetId ?? OWN_RULES}
          onValueChange={(v) => onChange(v === OWN_RULES ? null : v)}
          options={[
            { value: OWN_RULES, label: "This route's own rules" },
            ...(presets ?? []).map((p) => ({ value: p.id, label: `Preset: ${p.name}` })),
          ]}
          className="min-w-56"
        />
      </div>
      {preset ? (
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-mute">
          Shown below as read-only — every route using “{preset.name}” shares them.
          <Link href="/presets" className="inline-flex items-center gap-1 text-live hover:underline">
            Edit preset <ArrowSquareOut size={12} />
          </Link>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onDetach(parseRouteRules(preset.rules))}
          >
            Use my own rules instead
          </Button>
        </p>
      ) : (
        <p className="text-[12.5px] text-mute">
          These rules belong to this route only. Pick a preset to share one set of rules across routes.
        </p>
      )}
    </div>
  );
}
