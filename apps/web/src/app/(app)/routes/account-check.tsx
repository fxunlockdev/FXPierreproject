"use client";

import { useState } from "react";
import { CheckCircle, Stethoscope, XCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { ChannelRow } from "@/lib/types";
import { workerCall } from "@/lib/worker";

interface AccessCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * Asks Telegram, as the route's user account, whether it can post into the
 * receiver — and whether posts will appear as the group. Sends nothing.
 */
export function AccountCheck({
  accountId,
  receiver,
  topicId,
}: {
  accountId: string;
  receiver: ChannelRow;
  topicId: number | null;
}) {
  const [checks, setChecks] = useState<AccessCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await workerCall<{ checks: AccessCheck[] }>("accounts/check", {
        accountId,
        channelId: receiver.id,
        topicId,
      });
      setChecks(res.checks);
    } catch (err) {
      setChecks(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const allGood = checks !== null && checks.every((c) => c.ok);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-edge bg-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-mute">
          Ask Telegram whether this account can post into {receiver.title}. Nothing is sent.
        </p>
        <Button type="button" size="sm" onClick={run} loading={busy}>
          <Stethoscope size={14} /> Check this account
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {error}
        </p>
      )}
      {checks && (
        <ul aria-label="Account check results" className="flex flex-col gap-1.5">
          {checks.map((c) => (
            <li key={c.label} className="flex items-start gap-2 text-[13px]">
              {c.ok ? (
                <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-live" />
              ) : (
                <XCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-danger" />
              )}
              <span>
                <span className={c.ok ? "text-ink" : "font-medium text-danger"}>{c.label}</span>
                {c.detail && <span className="text-mute"> — {c.detail}</span>}
              </span>
            </li>
          ))}
          {allGood && (
            <li className="text-[12.5px] text-live">
              All set. If the route was auto-paused, switch it back on and retry failed posts from Activity.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
