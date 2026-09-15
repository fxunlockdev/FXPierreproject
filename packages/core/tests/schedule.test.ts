import { describe, expect, it } from 'vitest';
import { resolveTiming, RouteScheduleSchema, type RouteSchedule } from '../src/index.js';

// Monday 2026-09-14 10:00 UTC
const MONDAY_10 = new Date('2026-09-14T10:00:00Z');

const schedule = (input: object): RouteSchedule => RouteScheduleSchema.parse(input);

// Business hours Mon-Fri 08:00-18:00 UTC (dow: 0=Sun … 6=Sat)
const businessHours = schedule({
  tz: 'UTC',
  windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: '08:00', end: '18:00' })),
  offWindow: 'hold',
});

describe('resolveTiming', () => {
  it('sends immediately with no delay and no schedule', () => {
    expect(resolveTiming(MONDAY_10, 0, null, null)).toEqual({ action: 'send' });
  });

  it('schedules a delayed message', () => {
    const res = resolveTiming(MONDAY_10, 300, null, null);
    expect(res).toEqual({
      action: 'schedule',
      deliverAt: new Date('2026-09-14T10:05:00Z'),
      held: false,
    });
  });

  it('sends inside the window', () => {
    expect(resolveTiming(MONDAY_10, 0, businessHours, null)).toEqual({ action: 'send' });
  });

  it('holds outside the window until the next opening', () => {
    const friday20 = new Date('2026-09-18T20:00:00Z');
    const res = resolveTiming(friday20, 0, businessHours, null);
    expect(res).toEqual({
      action: 'schedule',
      deliverAt: new Date('2026-09-21T08:00:00Z'), // next Monday 08:00
      held: true,
    });
  });

  it('drops outside the window in drop mode', () => {
    const sched = schedule({ ...businessHours, offWindow: 'drop' });
    const saturday = new Date('2026-09-19T12:00:00Z');
    expect(resolveTiming(saturday, 0, sched, null)).toEqual({
      action: 'drop',
      reason: 'outside schedule window',
    });
  });

  it('drops held messages older than the configured limit', () => {
    const sched = schedule({ ...businessHours, dropHeldAfterMinutes: 60 });
    const friday20 = new Date('2026-09-18T20:00:00Z');
    const res = resolveTiming(friday20, 0, sched, null);
    expect(res.action).toBe('drop');
  });

  it('handles windows that cross midnight', () => {
    const night = schedule({
      tz: 'UTC',
      windows: [{ dow: 1, start: '22:00', end: '02:00' }],
      offWindow: 'hold',
    });
    // Monday 23:00 → inside
    expect(resolveTiming(new Date('2026-09-14T23:00:00Z'), 0, night, null).action).toBe('send');
    // Tuesday 01:00 → still inside Monday's window
    expect(resolveTiming(new Date('2026-09-15T01:00:00Z'), 0, night, null).action).toBe('send');
    // Tuesday 03:00 → outside
    expect(resolveTiming(new Date('2026-09-15T03:00:00Z'), 0, night, null).action).toBe(
      'schedule',
    );
  });

  it('evaluates windows in the configured timezone', () => {
    const paris = schedule({
      tz: 'Europe/Paris',
      windows: [{ dow: 1, start: '08:00', end: '18:00' }],
      offWindow: 'drop',
    });
    // 07:00 UTC = 09:00 Paris → inside
    expect(resolveTiming(new Date('2026-09-14T07:00:00Z'), 0, paris, null).action).toBe('send');
    // 17:00 UTC = 19:00 Paris → outside
    expect(resolveTiming(new Date('2026-09-14T17:00:00Z'), 0, paris, null).action).toBe('drop');
  });

  it('respects paused_until over everything else', () => {
    const pausedUntil = new Date('2026-09-14T12:00:00Z');
    const res = resolveTiming(MONDAY_10, 0, null, pausedUntil);
    expect(res).toEqual({ action: 'schedule', deliverAt: pausedUntil, held: false });
  });

  it('rejects an invalid timezone at parse time', () => {
    expect(
      RouteScheduleSchema.safeParse({ tz: 'Fake/Zone', windows: [], offWindow: 'hold' }).success,
    ).toBe(false);
  });
});
