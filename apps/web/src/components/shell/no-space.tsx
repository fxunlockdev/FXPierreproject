"use client";

import { useRouter } from "next/navigation";
import { LockSimple } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { supabaseBrowser } from "@/lib/supabase/client";
import { JoinSpaceForm } from "./join-space-form";

/** Signed in, but not a member of any active space. */
export function NoSpace({ email, disabled }: { email: string; disabled: boolean }) {
  const router = useRouter();
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="flex w-full max-w-md flex-col gap-6 rounded-2xl border border-edge bg-surface p-7">
        <div className="flex size-11 items-center justify-center rounded-xl border border-edge bg-raised text-faint">
          <LockSimple size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {disabled ? "This space is switched off" : "You're not in a space yet"}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-mute">
            {disabled
              ? "The platform operator has disabled your space, so relaying is paused and its data is hidden. Contact them to turn it back on, or join another space."
              : "You were removed from your space. Ask a space owner for an invite code to join theirs."}
          </p>
        </div>
        <JoinSpaceForm />
        <div className="flex items-center justify-between gap-3 border-t border-edge pt-4">
          <span className="truncate text-[12px] text-faint" title={email}>
            {email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await supabaseBrowser().auth.signOut();
              router.push("/login");
              router.refresh();
            }}
          >
            Sign out
          </Button>
        </div>
      </section>
    </main>
  );
}
