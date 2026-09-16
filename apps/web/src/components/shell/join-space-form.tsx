"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { SPACE_COOKIE } from "@/lib/space-cookie";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Redeems a teammate's invite code and opens that space. */
export function JoinSpaceForm({
  compact = false,
  onJoined,
}: {
  compact?: boolean;
  onJoined?: (spaceId: string) => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabaseBrowser().rpc("redeem_space_invite", {
      p_code: code.trim(),
    });
    if (rpcError || typeof data !== "string") {
      setBusy(false);
      setError(
        rpcError && !/invalid|expired/i.test(rpcError.message)
          ? rpcError.message
          : "That invite code is invalid or has expired.",
      );
      return;
    }
    document.cookie = `${SPACE_COOKIE}=${data}; path=/; max-age=31536000; samesite=lax`;
    onJoined?.(data);
    setCode("");
    setBusy(false);
    // the layout re-reads the space list (and role) on the server
    router.push("/overview");
    router.refresh();
  };

  return (
    <form onSubmit={join} className={`flex flex-col gap-3 ${compact ? "" : "w-full"}`}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Invite code" className="min-w-0 flex-1">
          <Input
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCDE-FGH23"
            autoComplete="off"
            spellCheck={false}
            className="font-mono tracking-wider"
          />
        </Field>
        <Button type="submit" variant={compact ? "outline" : "primary"} loading={busy}>
          Join space
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
