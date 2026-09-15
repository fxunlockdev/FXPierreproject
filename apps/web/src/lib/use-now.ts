import { useEffect, useState } from "react";
import { nowMs } from "./format";

/**
 * Current epoch millis, re-rendered every `intervalMs`. Use for anything
 * derived from "now" during render (heartbeat ages, schedule previews) so the
 * value is state, not an impure read in the render path.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(nowMs);

  useEffect(() => {
    const id = setInterval(() => setNow(nowMs()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
