"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, TrashSimple } from "@phosphor-icons/react";
import type { MediaKind, RouteRules } from "@pierre/core";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** Filters and transforms, shared by the route editor and the preset editor. */

export const MEDIA_OPTIONS: MediaKind[] = [
  "text",
  "photo",
  "video",
  "animation",
  "document",
  "audio",
  "voice",
  "sticker",
  "poll",
];

export function SwitchRow({
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

interface FieldsProps {
  rules: RouteRules;
  onChange: (patch: Partial<RouteRules>) => void;
  /** Rules that come from a preset are shown, not edited here. */
  readOnly?: boolean;
}

const toKeywords = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);

export function FilterFields({ rules, onChange, readOnly }: FieldsProps) {
  // Kept as typed: re-parsing on every keystroke would swallow the blank line
  // you just made by pressing Enter, and trim spaces mid-word.
  const [keywordText, setKeywordText] = useState(() => ({
    include: rules.filters.includeKeywords.join("\n"),
    exclude: rules.filters.excludeKeywords.join("\n"),
  }));
  const setFilters = (patch: Partial<RouteRules["filters"]>) =>
    onChange({ filters: { ...rules.filters, ...patch } });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Must contain (one per line)" hint="Empty = everything passes.">
          <Textarea
            rows={4}
            disabled={readOnly}
            value={keywordText.include}
            onChange={(e) => {
              setKeywordText((k) => ({ ...k, include: e.target.value }));
              setFilters({ includeKeywords: toKeywords(e.target.value) });
            }}
            placeholder={"EURUSD\nXAUUSD"}
          />
        </Field>
        <Field label="Must NOT contain (one per line)">
          <Textarea
            rows={4}
            disabled={readOnly}
            value={keywordText.exclude}
            onChange={(e) => {
              setKeywordText((k) => ({ ...k, exclude: e.target.value }));
              setFilters({ excludeKeywords: toKeywords(e.target.value) });
            }}
            placeholder={"promo\ngiveaway"}
          />
        </Field>
        <Field label="Required pattern (regex)" hint="Optional. e.g. TP\d">
          <Input
            disabled={readOnly}
            value={rules.filters.includeRegex ?? ""}
            onChange={(e) => setFilters({ includeRegex: e.target.value || undefined })}
            className="font-mono"
          />
        </Field>
        <Field label="Blocked pattern (regex)">
          <Input
            disabled={readOnly}
            value={rules.filters.excludeRegex ?? ""}
            onChange={(e) => setFilters({ excludeRegex: e.target.value || undefined })}
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex flex-col divide-y divide-edge border-y border-edge">
        <SwitchRow
          title="Case sensitive"
          hint="Match keyword capitalization exactly."
          checked={rules.filters.caseSensitive}
          onChange={(v) => setFilters({ caseSensitive: v })}
          disabled={readOnly}
        />
        <SwitchRow
          title="Whole words only"
          hint='"buy" will not match "buyer".'
          checked={rules.filters.wholeWord}
          onChange={(v) => setFilters({ wholeWord: v })}
          disabled={readOnly}
        />
      </div>
      <Field label="Allowed media types" hint="Nothing selected = all types pass.">
        <div className="flex flex-wrap gap-1.5">
          {MEDIA_OPTIONS.map((m) => {
            const active = rules.filters.mediaTypes?.includes(m) ?? false;
            return (
              <button
                key={m}
                type="button"
                disabled={readOnly}
                onClick={() => {
                  const current = rules.filters.mediaTypes ?? [];
                  const next = active ? current.filter((x) => x !== m) : [...current, m];
                  setFilters({ mediaTypes: next.length > 0 ? next : undefined });
                }}
                className={`rounded-md border px-2.5 py-1 text-[12.5px] transition-colors disabled:opacity-60 ${
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
            disabled={readOnly}
            value={rules.filters.minLength ?? ""}
            onChange={(e) => setFilters({ minLength: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </Field>
        <Field label="Max length (chars)">
          <Input
            type="number"
            min={0}
            disabled={readOnly}
            value={rules.filters.maxLength ?? ""}
            onChange={(e) => setFilters({ maxLength: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </Field>
      </div>
    </div>
  );
}

export function TransformFields({ rules, onChange, readOnly }: FieldsProps) {
  const setLinks = (patch: Partial<RouteRules["linkRemoval"]>) =>
    onChange({ linkRemoval: { ...rules.linkRemoval, ...patch } });
  const setReplacements = (replacements: RouteRules["replacements"]) => onChange({ replacements });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-2 text-[13px] font-medium text-mute">Find &amp; replace (runs in order)</p>
        <div className="flex flex-col gap-2">
          {rules.replacements.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                disabled={readOnly}
                value={r.find}
                onChange={(e) => {
                  const next = [...rules.replacements];
                  next[i] = { ...r, find: e.target.value };
                  setReplacements(next);
                }}
                placeholder="find"
                className="flex-1 font-mono text-[13px]"
              />
              <span className="text-faint">→</span>
              <Input
                disabled={readOnly}
                value={r.replace}
                onChange={(e) => {
                  const next = [...rules.replacements];
                  next[i] = { ...r, replace: e.target.value };
                  setReplacements(next);
                }}
                placeholder="replace with"
                className="flex-1 font-mono text-[13px]"
              />
              <button
                type="button"
                title="Regex"
                disabled={readOnly}
                onClick={() => {
                  const next = [...rules.replacements];
                  next[i] = { ...r, regex: !r.regex };
                  setReplacements(next);
                }}
                className={`rounded-md border px-1.5 py-1 font-mono text-[11px] disabled:opacity-60 ${
                  r.regex ? "border-live/40 bg-live-soft text-live" : "border-edge text-faint"
                }`}
              >
                .*
              </button>
              {!readOnly && (
                <>
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label="Move up"
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...rules.replacements];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        setReplacements(next);
                      }}
                      className="text-faint hover:text-ink disabled:opacity-30"
                    >
                      <ArrowUp size={11} />
                    </button>
                    <button
                      type="button"
                      aria-label="Move down"
                      disabled={i === rules.replacements.length - 1}
                      onClick={() => {
                        const next = [...rules.replacements];
                        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                        setReplacements(next);
                      }}
                      className="text-faint hover:text-ink disabled:opacity-30"
                    >
                      <ArrowDown size={11} />
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label="Remove rule"
                    onClick={() => setReplacements(rules.replacements.filter((_, x) => x !== i))}
                    className="rounded-md p-1.5 text-faint hover:bg-danger-soft hover:text-danger"
                  >
                    <TrashSimple size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() =>
                setReplacements([...rules.replacements, { find: "", replace: "", regex: false, caseSensitive: false }])
              }
            >
              <Plus size={13} /> Add replacement
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-edge pt-4">
        <p className="mb-2 text-[13px] font-medium text-mute">Link &amp; mention removal</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="URLs">
            <Select
              disabled={readOnly}
              value={rules.linkRemoval.urls}
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
              disabled={readOnly}
              value={rules.linkRemoval.placeholder}
              onChange={(e) => setLinks({ placeholder: e.target.value })}
              placeholder="[link removed]"
            />
          </Field>
        </div>
        <div className="mt-2 flex flex-col divide-y divide-edge border-y border-edge">
          <SwitchRow
            title="Strip @mentions"
            hint="Removes @usernames from the text."
            checked={rules.linkRemoval.mentions}
            onChange={(v) => setLinks({ mentions: v })}
            disabled={readOnly}
          />
          <SwitchRow
            title="Strip #hashtags"
            hint="Removes hashtags from the text."
            checked={rules.linkRemoval.hashtags}
            onChange={(v) => setLinks({ hashtags: v })}
            disabled={readOnly}
          />
          <SwitchRow
            title="Drop inline buttons"
            hint="Posts are delivered without the source's buttons."
            checked={rules.linkRemoval.buttons}
            onChange={(v) => setLinks({ buttons: v })}
            disabled={readOnly}
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
            disabled={readOnly}
            value={rules.header}
            onChange={(e) => onChange({ header: e.target.value })}
            placeholder="**{master}**"
          />
        </Field>
        <Field label="Footer" hint="Added below each post — same formatting and variables.">
          <Textarea
            rows={2}
            disabled={readOnly}
            value={rules.footer}
            onChange={(e) => onChange({ footer: e.target.value })}
            placeholder="__relayed {time}__"
          />
        </Field>
      </div>
      <Field
        label="Strip source signature (regex)"
        hint="Removes a matching block from the END of each post, e.g. — VIP Team.*"
      >
        <Input
          disabled={readOnly}
          value={rules.signatureStrip}
          onChange={(e) => onChange({ signatureStrip: e.target.value })}
          className="font-mono"
        />
      </Field>
    </div>
  );
}
