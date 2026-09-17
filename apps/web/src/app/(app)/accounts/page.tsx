"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DeviceMobile, Plus, Robot, UserCircle } from "@phosphor-icons/react";
import { Badge, stateTone } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import { useAccounts, useUpdateAccount } from "@/lib/queries";
import type { AccountRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";

const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  connected: "connected",
  relogin_required: "re-login required",
  restricted: "restricted",
  disabled: "disabled",
};

type LoginPhase = "form" | "starting" | "code" | "password" | "done" | "error";

function ConnectUserDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<LoginPhase>("form");
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loginId = useRef<string | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (polling.current) clearInterval(polling.current);
    polling.current = null;
  };

  useEffect(() => stopPolling, []);

  const poll = () => {
    stopPolling();
    polling.current = setInterval(async () => {
      if (!loginId.current) return;
      try {
        const status = await workerCall<{ phase: LoginPhase; error?: string }>(`login/${loginId.current}`);
        if (status.phase === "code" || status.phase === "password") {
          setPhase(status.phase);
          stopPolling();
        } else if (status.phase === "done") {
          setPhase("done");
          stopPolling();
          toast.success("Telegram account connected");
        } else if (status.phase === "error") {
          setPhase("error");
          setError(status.error ?? "login failed");
          stopPolling();
        }
      } catch (err) {
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
        stopPolling();
      }
    }, 1200);
  };

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await workerCall<{ loginId: string }>("login/start", { phone: phone.trim(), label });
      loginId.current = res.loginId;
      setPhase("starting");
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await workerCall(`login/${loginId.current}/code`, { code: code.trim() });
      setPhase("starting");
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await workerCall(`login/${loginId.current}/password`, { password });
      setPhase("starting");
      poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    stopPolling();
    loginId.current = null;
    setPhase("form");
    setCode("");
    setPassword("");
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Plus size={14} weight="bold" /> Connect user account
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Connect a Telegram account"
        description="Use a dedicated account, not a personal one. You type the code and password yourself — they go straight to the relay, never stored in the browser. To post into a group as the group itself, make this account an admin there with “Remain anonymous” on."
      >
        {phase === "form" && (
          <form onSubmit={start} className="flex flex-col gap-4">
            <Field label="Label" hint="How this account appears in the dashboard.">
              <Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Relay reader" />
            </Field>
            <Field label="Phone number" hint="International format, e.g. +33612345678.">
              <Input
                required
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+336…"
              />
            </Field>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <Button type="submit" variant="primary" loading={busy}>
              Send login code
            </Button>
          </form>
        )}

        {phase === "starting" && (
          <div className="flex items-center gap-3 py-6">
            <span className="size-4 animate-spin rounded-full border-2 border-live border-t-transparent" />
            <p className="text-[13px] text-mute">Talking to Telegram…</p>
          </div>
        )}

        {phase === "code" && (
          <form onSubmit={sendCode} className="flex flex-col gap-4">
            <div className="flex items-start gap-3 rounded-lg border border-edge bg-raised px-3 py-2.5">
              <DeviceMobile size={17} className="mt-0.5 shrink-0 text-live" />
              <p className="text-[13px] leading-relaxed text-mute">
                Telegram sent a login code to that account — check the official Telegram app (not SMS).
              </p>
            </div>
            <Field label="Login code">
              <Input
                required
                autoFocus
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="12345"
                className="font-mono tracking-[0.3em]"
              />
            </Field>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <Button type="submit" variant="primary" loading={busy}>
              Verify code
            </Button>
          </form>
        )}

        {phase === "password" && (
          <form onSubmit={sendPassword} className="flex flex-col gap-4">
            <Field label="Two-step verification password" hint="The account has 2FA enabled — enter its cloud password.">
              <Input
                required
                autoFocus
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <p className="text-[13px] text-danger">{error}</p>}
            <Button type="submit" variant="primary" loading={busy}>
              Finish sign-in
            </Button>
          </form>
        )}

        {phase === "done" && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-live-soft text-live">
              <UserCircle size={24} weight="fill" />
            </span>
            <p className="text-sm font-medium">Account connected</p>
            <p className="text-[13px] text-mute">It can now read masters and send to receivers.</p>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-4">
            <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
              {error ?? "Login failed"}
            </p>
            <Button variant="outline" onClick={reset}>
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddBotDialog() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [alertSender, setAlertSender] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await workerCall<{ username: string }>("accounts/bot", {
        token: token.trim(),
        label,
        isAlertSender: alertSender,
      });
      toast.success(`Bot @${res.username} connected`);
      setOpen(false);
      setToken("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Robot size={14} /> Add bot
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Add a bot"
        description="Create one with @BotFather and make it admin in your masters and receivers. Each extra bot adds its own Telegram rate limits — the relay spreads posts across all of them automatically."
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Label">
            <Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Relay bot" />
          </Field>
          <Field label="Bot token" hint="Looks like 1234567890:AA… — from @BotFather.">
            <Input
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="1234567890:AA…"
              className="font-mono"
            />
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-edge px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium">Use for alerts</p>
              <p className="text-xs text-mute">Failure alerts are sent through this bot.</p>
            </div>
            <Switch checked={alertSender} onCheckedChange={setAlertSender} label="Use for alerts" />
          </div>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Connect bot
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccountCard({ account }: { account: AccountRow }) {
  const update = useUpdateAccount();
  const roleSwitch = (key: "is_reader" | "is_sender" | "is_alert_sender", label: string) => (
    <label className="flex items-center justify-between gap-2 py-1.5 text-[13px] text-mute">
      {label}
      <Switch
        checked={account[key]}
        label={`${label} for ${account.label}`}
        onCheckedChange={(v) => update.mutate({ id: account.id, patch: { [key]: v } })}
      />
    </label>
  );

  return (
    <article className="flex flex-col rounded-xl border border-edge bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex size-9 items-center justify-center rounded-lg border border-edge ${
              account.kind === "bot" ? "text-warn" : "text-live"
            }`}
          >
            {account.kind === "bot" ? <Robot size={18} /> : <UserCircle size={18} />}
          </span>
          <div>
            <p className="text-[14px] font-semibold tracking-tight">{account.label}</p>
            <p className="font-mono text-[11.5px] text-faint">
              {account.username ? `@${account.username}` : account.phone ?? account.kind}
            </p>
          </div>
        </div>
        <Badge tone={stateTone(account.status)}>{STATUS_LABEL[account.status] ?? account.status}</Badge>
      </div>

      <div className="mt-4 divide-y divide-edge border-t border-edge">
        {roleSwitch("is_reader", "Reads master channels")}
        {roleSwitch("is_sender", "Sends to receivers")}
        {roleSwitch("is_alert_sender", "Delivers alerts")}
      </div>

      <p className="mt-3 font-mono text-[11px] text-faint">
        pace {account.max_msgs_per_minute}/min · seen {timeAgo(account.last_seen_at)}
      </p>
      {account.last_error && <p className="mt-1 text-[12px] text-danger">{account.last_error}</p>}
    </article>
  );
}

export default function AccountsPage() {
  const { data: accounts, isLoading } = useAccounts();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Accounts</h1>
          <p className="mt-0.5 text-[13px] text-mute">
            User accounts read any channel they joined; bots send fast and deliver alerts.
          </p>
        </div>
        <div className="flex gap-2">
          <AddBotDialog />
          <ConnectUserDialog />
        </div>
      </header>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      ) : (accounts ?? []).length === 0 ? (
        <EmptyState
          icon={<UserCircle size={20} />}
          title="No Telegram accounts connected"
          hint="Add a bot for fast sending and alerts. Connect a dedicated Telegram account too if posts in a group must appear as the group itself."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(accounts ?? []).map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      )}
    </div>
  );
}
