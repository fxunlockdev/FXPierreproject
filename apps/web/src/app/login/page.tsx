"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { supabaseBrowser } from "@/lib/supabase/client";

function RelayGraphic() {
  return (
    <svg viewBox="0 0 420 300" className="w-full max-w-md" aria-hidden>
      {[70, 130, 190].map((y, i) => (
        <g key={y}>
          <rect x="20" y={y - 14} width="96" height="28" rx="8" className="fill-[var(--raised)] stroke-[var(--edge)]" />
          <circle cx="34" cy={y} r="4" className="fill-[var(--faint)]" />
          <path
            d={`M116 ${y} C 190 ${y}, 200 150, 268 150`}
            className="signal-line fill-none stroke-[var(--live)]"
            strokeWidth="1.5"
            style={{ animationDelay: `${i * 0.35}s` }}
          />
        </g>
      ))}
      <rect x="268" y="122" width="130" height="56" rx="12" className="fill-[var(--raised)] stroke-[var(--edge-strong)]" />
      <circle cx="290" cy="150" r="5" className="fill-[var(--live)]" />
      <rect x="304" y="138" width="76" height="7" rx="3.5" className="fill-[var(--edge-strong)]" />
      <rect x="304" y="152" width="52" height="7" rx="3.5" className="fill-[var(--edge)]" />
      <path d="M333 178 v 42 h 60" className="fill-none stroke-[var(--edge-strong)]" strokeDasharray="3 5" />
      <rect x="393" y="212" width="14" height="14" rx="4" className="fill-[var(--live-soft)] stroke-[var(--live)]" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<"signin" | "activate">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    params.get("reason") === "not-invited"
      ? "This account is not on the member list. Ask an admin to invite you."
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = supabaseBrowser();
    try {
      if (mode === "activate") {
        const { data: signUpData, error: signUpErr } = await sb.auth.signUp({ email, password });
        if (signUpErr) {
          throw new Error(
            /invite-only|database error/i.test(signUpErr.message)
              ? "That email has not been invited. Ask an admin to add you first."
              : signUpErr.message,
          );
        }
        // With email confirmation enabled (production), signUp returns no
        // session — the account activates via the link in their inbox.
        if (!signUpData.session) {
          setNotice("Almost there — open the confirmation link we just emailed you, then sign in.");
          setMode("signin");
          return;
        }
      }
      const { error: signInErr } = await sb.auth.signInWithPassword({ email, password });
      if (signInErr) throw new Error(signInErr.message);
      router.push("/overview");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === "signin" ? "Sign in" : "Activate your invite"}
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          {mode === "signin"
            ? "Access is invite-only. Use the email an admin added for you."
            : "First time here? Set a password for your invited email."}
        </p>
      </div>

      <Field label="Email">
        <Input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </Field>
      <Field label="Password" hint={mode === "activate" ? "At least 8 characters." : undefined}>
        <Input
          type="password"
          required
          minLength={mode === "activate" ? 8 : undefined}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
        />
      </Field>

      {error && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-live/30 bg-live-soft px-3 py-2 text-[13px] text-live">
          {notice}
        </p>
      )}

      <Button type="submit" variant="primary" loading={busy}>
        {mode === "signin" ? "Sign in" : "Create password & sign in"}
      </Button>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "activate" : "signin");
          setError(null);
        }}
        className="text-left text-[13px] text-mute underline-offset-4 transition-colors hover:text-ink hover:underline"
      >
        {mode === "signin" ? "First time here? Activate your invite" : "Already activated? Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh md:grid-cols-[1.1fr_1fr]">
      <section className="hidden flex-col justify-between border-r border-edge bg-surface p-10 md:flex">
        <div className="flex items-center gap-2.5">
          <svg width="28" height="28" viewBox="0 0 26 26" aria-hidden>
            <rect x="1" y="1" width="24" height="24" rx="7" className="fill-none stroke-[var(--edge-strong)]" />
            <path d="M6 9h6.5a3 3 0 0 1 0 6H10" className="fill-none stroke-[var(--live)]" strokeWidth="2" strokeLinecap="round" />
            <circle cx="19" cy="17" r="2.4" className="fill-[var(--live)]" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">Switchyard</span>
        </div>
        <RelayGraphic />
        <p className="max-w-sm text-[13px] leading-relaxed text-mute">
          Watches your master channels and relays every post to the receivers you route them to —
          filtered, transformed, and on schedule.
        </p>
      </section>
      <section className="flex items-center justify-center p-6 md:p-10">
        <Suspense>
          <LoginForm />
        </Suspense>
      </section>
    </div>
  );
}
