type Tone = "live" | "warn" | "danger" | "neutral";

const tones: Record<Tone, string> = {
  live: "bg-live-soft text-live border-live/25",
  warn: "bg-warn-soft text-warn border-warn/25",
  danger: "bg-danger-soft text-danger border-danger/25",
  neutral: "bg-raised text-mute border-edge",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function stateTone(state: string): Tone {
  switch (state) {
    case "done":
    case "ok":
    case "connected":
      return "live";
    case "failed":
    case "unavailable":
    case "no_permission":
    case "relogin_required":
    case "restricted":
      return "danger";
    case "scheduled":
    case "held":
    case "sending":
    case "protected":
    case "pending":
      return "warn";
    default:
      return "neutral";
  }
}

export function HealthDot({ health }: { health: string }) {
  const color =
    health === "ok"
      ? "bg-live"
      : health === "unknown"
        ? "bg-faint"
        : health === "protected"
          ? "bg-warn"
          : "bg-danger";
  return (
    <span className="relative inline-flex size-2 shrink-0">
      <span className={`size-2 rounded-full ${color} ${health === "ok" ? "pulse-live" : ""}`} />
    </span>
  );
}
