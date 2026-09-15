import { DateTime } from 'luxon';
import type { RouteSchedule } from './rules.js';

export type TimingDecision =
  | { action: 'send' }
  | { action: 'schedule'; deliverAt: Date; held: boolean }
  | { action: 'drop'; reason: string };

const toMinutes = (hhmm: string): number => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** A window may cross midnight (e.g. 22:00 → 02:00). */
function isInWindow(dt: DateTime, windows: RouteSchedule['windows']): boolean {
  const minutes = dt.hour * 60 + dt.minute;
  // luxon weekday: 1 = Monday … 7 = Sunday → convert to 0 = Sunday … 6 = Saturday
  const dow = dt.weekday % 7;
  const prevDow = (dow + 6) % 7;

  return windows.some((w) => {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (start < end) return w.dow === dow && minutes >= start && minutes < end;
    if (start > end) {
      // crosses midnight: [start, 24:00) on w.dow, [00:00, end) the next day
      return (w.dow === dow && minutes >= start) || (w.dow === prevDow && minutes < end);
    }
    return false; // start === end → empty window
  });
}

/** Earliest window opening at or after `from`, searched over the next 8 days. */
function nextWindowStart(from: DateTime, windows: RouteSchedule['windows']): DateTime | null {
  if (windows.length === 0) return null;
  let best: DateTime | null = null;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const day = from.plus({ days: dayOffset }).startOf('day');
    const dow = day.weekday % 7;
    for (const w of windows) {
      if (w.dow !== dow) continue;
      const startMin = toMinutes(w.start);
      const candidate = day.plus({ minutes: startMin });
      if (candidate < from) continue;
      if (best === null || candidate < best) best = candidate;
    }
    if (best) return best;
  }
  return best;
}

/**
 * Decide when (and whether) a message should go out.
 * Order: pause → delay → schedule window.
 */
export function resolveTiming(
  now: Date,
  delaySeconds: number,
  schedule: RouteSchedule | null | undefined,
  pausedUntil: Date | null | undefined,
): TimingDecision {
  let base = new Date(now.getTime() + Math.max(0, delaySeconds) * 1000);
  if (pausedUntil && pausedUntil.getTime() > base.getTime()) {
    base = pausedUntil;
  }

  if (!schedule || schedule.windows.length === 0) {
    if (base.getTime() - now.getTime() > 1000) {
      return { action: 'schedule', deliverAt: base, held: false };
    }
    return { action: 'send' };
  }

  const zone = schedule.tz;
  let dt = DateTime.fromJSDate(base, { zone });
  if (!dt.isValid) dt = DateTime.fromJSDate(base, { zone: 'UTC' });

  if (isInWindow(dt, schedule.windows)) {
    if (base.getTime() - now.getTime() > 1000) {
      return { action: 'schedule', deliverAt: base, held: false };
    }
    return { action: 'send' };
  }

  if (schedule.offWindow === 'drop') {
    return { action: 'drop', reason: 'outside schedule window' };
  }

  const opening = nextWindowStart(dt, schedule.windows);
  if (!opening) return { action: 'drop', reason: 'schedule has no usable window' };

  const heldMinutes = opening.toJSDate().getTime() - base.getTime();
  if (
    schedule.dropHeldAfterMinutes !== undefined &&
    heldMinutes > schedule.dropHeldAfterMinutes * 60_000
  ) {
    return { action: 'drop', reason: `held longer than ${schedule.dropHeldAfterMinutes} min` };
  }

  return { action: 'schedule', deliverAt: opening.toJSDate(), held: true };
}
