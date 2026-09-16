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

type Mode = "signin" | "signup";

function friendlySignUpError(message: string): string {
  if (/already registered|already exists/i.test(message)) {
    return "An account with this email already exists. Sign in instead.";
  }
  if (/invalid or expired invite/i.test(message)) return "That invite code is invalid or has expired.";
  if (/sign-ups are closed|database error/i.test(message)) {
    return "Sign-ups are closed right now. Ask a space owner for an invite code.";
  }
  return message;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>(params.get("mode") === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [spaceName, setSpaceName] = useState("");
  const [inviteCode, setInviteCode] = useState(params.get("code") ?? "");
  const [joining, setJoining] = useState(Boolean(params.get("code")));
  const [signupsClosed, setSignupsClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const switchMode = async (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    if (next !== "signup") return;
    const { data } = await supabaseBrowser().rpc("check_signup", { p_code: null });
    const closed = data === "closed";
    setSignupsClosed(closed);
    if (closed) setJoining(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const sb = supabaseBrowser();
    try {
      if (mode === "signup") {
        const code = joining ? inviteCode.trim() : "";
        const { data: verdict, error: checkErr } = await sb.rpc("check_signup", { p_code: code || null });
        if (checkErr) throw new Error(checkErr.message);
        if (verdict === "closed") {
          setSignupsClosed(true);
          setJoining(true);
          throw new Error("Sign-ups are closed right now. Ask a space owner for an invite code.");
        }
        if (verdict === "invalid_code") throw new Error("That invite code is invalid or has expired.");

        const { data: signUpData, error: signUpErr } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: code ? { invite_code: code } : { space_name: spaceName.trim() || undefined },
          },
        });
        if (signUpErr) throw new Error(friendlySignUpError(signUpErr.message));
        // With email confirmation enabled, signUp returns no session — the
        // account activates via the link in the inbox.
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

  const signup = mode === "signup";

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{signup ? "Create your account" : "Sign in"}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          {signup
            ? joining
              ? "Joining a team? Enter the invite code a space owner gave you."
              : "You get your own private space — your bots, channels and logs are visible only to you and the teammates you invite."
            : "Welcome back. Your spaces are waiting."}
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
      <Field label="Password" hint={signup ? "At least 8 characters." : undefined}>
        <Input
          type="password"
          required
          minLength={signup ? 8 : undefined}
          autoComplete={signup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
        />
      </Field>

      {signup && !joining && (
        <Field label="Space name" hint="Optional — you can rename it later.">
          <Input
            value={spaceName}
            maxLength={80}
            onChange={(e) => setSpaceName(e.target.value)}
            placeholder="Acme signals"
          />
        </Field>
      )}
      {signup && signupsClosed && (
        <p role="status" className="rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          New sign-ups are closed right now — you can still join with an invite code from a space owner.
        </p>
      )}
      {signup && joining && (
        <Field label="Invite code">
          <Input
            required
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            placeholder="ABCDE-FGH23"
            autoComplete="off"
            spellCheck={false}
            className="font-mono tracking-wider"
          />
        </Field>
      )}
      {signup && !signupsClosed && (
        <button
          type="button"
          onClick={() => setJoining(!joining)}
          className="-mt-1 text-left text-[12.5px] text-mute underline-offset-4 transition-colors hover:text-ink hover:underline"
        >
          {joining ? "No code? Create a new space instead" : "Have an invite code? Join a team"}
        </button>
      )}

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
        {signup ? (joining ? "Create account & join" : "Create account") : "Sign in"}
      </Button>

      <button
        type="button"
        onClick={() => void switchMode(signup ? "signin" : "signup")}
        className="text-left text-[13px] text-mute underline-offset-4 transition-colors hover:text-ink hover:underline"
      >
        {signup ? "Already have an account? Sign in" : "New here? Create an account"}
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
