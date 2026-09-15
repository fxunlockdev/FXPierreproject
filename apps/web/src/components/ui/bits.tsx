"use client";

/** Small shared pieces: skeletons, empty states, stats, section headers. */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`shimmer rounded-md ${className}`} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-edge px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-edge bg-raised text-faint">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {hint && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-mute">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "live" | "warn" | "danger";
}) {
  const toneClass =
    tone === "live" ? "text-live" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 py-4 first:pl-0 last:pr-0">
      <span className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-faint">{label}</span>
      <span className={`tabular font-mono text-2xl font-semibold leading-none tracking-tight ${toneClass}`}>
        {value}
      </span>
      {sub && <span className="truncate text-xs text-mute">{sub}</span>}
    </div>
  );
}

export function SectionHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-mute">{hint}</p>}
      </div>
      {action}
    </div>
  );
}
