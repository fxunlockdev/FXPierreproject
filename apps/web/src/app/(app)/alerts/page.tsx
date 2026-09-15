"use client";

import { useState } from "react";
import { toast } from "sonner";
import { BellRinging, CheckCircle, PaperPlaneTilt, Warning } from "@phosphor-icons/react";
import { EmptyState, SectionHeader, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import { useAlertSettings, useIncidents, useUpdateAlertSettings } from "@/lib/queries";
import { INCIDENT_LABELS } from "@/lib/types";
import { workerCall } from "@/lib/worker";

const TRIGGER_HINTS: Record<string, string> = {
  receiver_no_permission: "A receiver refused a post (lost admin rights, deleted…)",
  master_unavailable: "A master became unreadable (left, banned, deleted)",
  protected_content: "A master turned out to be non-forwardable",
  session_revoked: "A Telegram session was terminated and needs re-login",
  account_restricted: "Telegram restricted one of the relay accounts",
  worker_offline: "The relay stopped sending heartbeats",
  flood_wait: "Telegram imposed a long rate-limit wait (> 60s)",
  master_silent: "A master posted nothing for a long time",
  route_autopaused: "A route was paused after repeated failures",
};

function DeliverySettings() {
  const { data: settings, isLoading } = useAlertSettings();
  if (isLoading || !settings) return <Skeleton className="h-72" />;
  return <DeliveryForm settings={settings} />;
}

type AlertSettingsRow = NonNullable<ReturnType<typeof useAlertSettings>["data"]>;

function DeliveryForm({ settings }: { settings: AlertSettingsRow }) {
  const update = useUpdateAlertSettings();
  // Seeded from the server row once — refetches must not stomp in-progress edits.
  const [form, setForm] = useState({
    telegram_enabled: settings.telegram_enabled,
    telegram_target: settings.telegram_target ?? "",
    webhook_enabled: settings.webhook_enabled,
    webhook_url: settings.webhook_url ?? "",
    email_enabled: settings.email_enabled,
    email_to: settings.email_to ?? "",
    cooldown_minutes: settings.cooldown_minutes,
  });
  const [triggers, setTriggers] = useState<Record<string, boolean>>(settings.triggers ?? {});
  const [testing, setTesting] = useState(false);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    update.mutate(
      {
        ...form,
        telegram_target: form.telegram_target || null,
        webhook_url: form.webhook_url || null,
        email_to: form.email_to || null,
        triggers,
      },
      { onSuccess: () => toast.success("Alert settings saved") },
    );
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      await workerCall("alerts/test", {});
      toast.success("Test alert dispatched — check your destinations");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 border-b border-edge pb-4">
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Telegram</p>
            <p className="text-[12.5px] text-mute">Sent by the alert bot to a chat or channel.</p>
          </div>
          <Switch
            checked={form.telegram_enabled}
            label="Telegram alerts"
            onCheckedChange={(v) => setForm((f) => ({ ...f, telegram_enabled: v }))}
          />
        </div>
        {form.telegram_enabled && (
          <Field
            label="Telegram target"
            hint="A private channel @username (add the alert bot as admin) or a numeric chat id."
          >
            <Input
              value={form.telegram_target}
              onChange={(e) => setForm((f) => ({ ...f, telegram_target: e.target.value }))}
              placeholder="@my_alerts_channel"
            />
          </Field>
        )}

        <div className="flex items-start justify-between gap-4 border-b border-edge pb-4">
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Webhook</p>
            <p className="text-[12.5px] text-mute">JSON POST — works with Slack and Discord webhooks.</p>
          </div>
          <Switch
            checked={form.webhook_enabled}
            label="Webhook alerts"
            onCheckedChange={(v) => setForm((f) => ({ ...f, webhook_enabled: v }))}
          />
        </div>
        {form.webhook_enabled && (
          <Field label="Webhook URL">
            <Input
              type="url"
              value={form.webhook_url}
              onChange={(e) => setForm((f) => ({ ...f, webhook_url: e.target.value }))}
              placeholder="https://hooks.slack.com/…"
            />
          </Field>
        )}

        <div className="flex items-start justify-between gap-4 border-b border-edge pb-4">
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium">Email</p>
            <p className="text-[12.5px] text-mute">Needs a RESEND_API_KEY on the relay worker.</p>
          </div>
          <Switch
            checked={form.email_enabled}
            label="Email alerts"
            onCheckedChange={(v) => setForm((f) => ({ ...f, email_enabled: v }))}
          />
        </div>
        {form.email_enabled && (
          <Field label="Email to">
            <Input
              type="email"
              value={form.email_to}
              onChange={(e) => setForm((f) => ({ ...f, email_to: e.target.value }))}
              placeholder="ops@company.com"
            />
          </Field>
        )}

        <Field label="Cooldown (minutes)" hint="The same alert never repeats faster than this.">
          <Input
            type="number"
            min={0}
            max={1440}
            value={form.cooldown_minutes}
            onChange={(e) => setForm((f) => ({ ...f, cooldown_minutes: Number(e.target.value) }))}
            className="w-28"
          />
        </Field>
      </div>

      <div>
        <p className="mb-2 text-[13px] font-medium text-mute">Triggers</p>
        <ul className="divide-y divide-edge border-y border-edge">
          {Object.keys(TRIGGER_HINTS).map((key) => (
            <li key={key} className="flex items-center justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{INCIDENT_LABELS[key] ?? key}</p>
                <p className="truncate text-[12px] text-faint">{TRIGGER_HINTS[key]}</p>
              </div>
              <Switch
                checked={triggers[key] !== false}
                label={INCIDENT_LABELS[key] ?? key}
                onCheckedChange={(v) => setTriggers((t) => ({ ...t, [key]: v }))}
              />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" loading={testing} onClick={sendTest}>
          <PaperPlaneTilt size={14} /> Send test alert
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

export default function AlertsPage() {
  const { data: incidents, isLoading } = useIncidents();
  const open = (incidents ?? []).filter((i) => i.status === "open");
  const resolved = (incidents ?? []).filter((i) => i.status === "resolved").slice(0, 10);

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
        <p className="mt-0.5 text-[13px] text-mute">
          Open incidents, their history, and where warnings get delivered.
        </p>
      </header>

      <section>
        <SectionHeader title={`Open incidents — ${open.length}`} />
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : open.length === 0 ? (
          <EmptyState
            icon={<BellRinging size={20} />}
            title="Nothing is on fire"
            hint="When a channel breaks, a session drops or the relay goes quiet, it shows up here."
          />
        ) : (
          <ul className="divide-y divide-edge border-y border-edge">
            {open.map((i) => (
              <li key={i.id} className="flex items-start gap-3 py-3">
                <Warning size={17} weight="fill" className="mt-0.5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium">{INCIDENT_LABELS[i.kind] ?? i.kind}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-mute">{i.message}</p>
                </div>
                <div className="shrink-0 text-right font-mono text-[11px] text-faint">
                  <p>first {timeAgo(i.first_seen)}</p>
                  <p>last {timeAgo(i.last_seen)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 && (
        <section>
          <SectionHeader title="Recently resolved" />
          <ul className="divide-y divide-edge border-y border-edge">
            {resolved.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 opacity-70">
                <CheckCircle size={16} weight="fill" className="shrink-0 text-live" />
                <p className="min-w-0 flex-1 truncate text-[13px] text-mute">
                  <span className="font-medium text-ink">{INCIDENT_LABELS[i.kind] ?? i.kind}</span> — {i.message}
                </p>
                <span className="shrink-0 font-mono text-[11px] text-faint">
                  {i.resolved_at ? timeAgo(i.resolved_at) : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <SectionHeader title="Delivery" hint="Where and when alerts are sent." />
        <DeliverySettings />
      </section>
    </div>
  );
}
