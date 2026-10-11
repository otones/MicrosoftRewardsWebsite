// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RUN_AT,
  DEFAULT_RUN_AT_MINUTES,
  MINUTES_PER_DAY,
  formatTimeOfDay,
  isAnchoredAt,
  nextTimeOfDay,
  parseTimeOfDay,
  timeOfDayToday,
} from './dailyRunTime';

function atLocal(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m, d, h, min, 0, 0).getTime();
}

// The invariant the DST comment rests on: whatever the offset does on that day,
// the instant is that clock time locally.
function localMinutesOf(instant: number): number {
  const at = new Date(instant);
  return at.getHours() * 60 + at.getMinutes();
}

describe('parseTimeOfDay', () => {
  it('parses what a time input produces', () => {
    expect(parseTimeOfDay('09:00')).toBe(9 * 60);
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(MINUTES_PER_DAY - 1);
  });

  it('accepts seconds and a sloppy single-digit hour', () => {
    expect(parseTimeOfDay('09:00:00')).toBe(9 * 60);
    expect(parseTimeOfDay('9:00')).toBe(9 * 60);
    expect(parseTimeOfDay(' 09:00 ')).toBe(9 * 60);
  });

  // A bad stored value must fall through to the default rather than leave the run
  // with no time of day at all.
  it('rejects everything it cannot read as a time of day', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('09:60')).toBeNull();
    expect(parseTimeOfDay('09')).toBeNull();
    expect(parseTimeOfDay('9am')).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('abc')).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
    expect(parseTimeOfDay(undefined)).toBeNull();
    expect(parseTimeOfDay(540)).toBeNull();
    expect(parseTimeOfDay({ hours: 9 })).toBeNull();
  });

  it('round-trips the shipped default', () => {
    expect(DEFAULT_RUN_AT).toBe('09:00');
    expect(parseTimeOfDay(DEFAULT_RUN_AT)).toBe(DEFAULT_RUN_AT_MINUTES);
  });
});

describe('formatTimeOfDay', () => {
  it('pads to the HH:MM a time input expects', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(9 * 60)).toBe('09:00');
    expect(formatTimeOfDay(9 * 60 + 5)).toBe('09:05');
    expect(formatTimeOfDay(MINUTES_PER_DAY - 1)).toBe('23:59');
  });
});

describe('timeOfDayToday', () => {
  it('returns that local time on the day of the instant given', () => {
    const now = atLocal(2026, 9, 11, 15, 30);

    expect(timeOfDayToday(9 * 60, now)).toBe(atLocal(2026, 9, 11, 9, 0));
  });

  it('stays that clock time whatever the instant, including just after midnight', () => {
    for (const now of [
      atLocal(2026, 9, 11, 0, 1),
      atLocal(2026, 9, 11, 12, 0),
      atLocal(2026, 11, 31, 23, 59),
      atLocal(2027, 0, 1, 8, 59),
    ]) {
      expect(localMinutesOf(timeOfDayToday(DEFAULT_RUN_AT_MINUTES, now))).toBe(DEFAULT_RUN_AT_MINUTES);
    }
  });
});

describe('nextTimeOfDay', () => {
  it('uses today while the time is still ahead', () => {
    const now = atLocal(2026, 9, 11, 8, 0);

    expect(nextTimeOfDay(9 * 60, now)).toBe(atLocal(2026, 9, 11, 9, 0));
  });

  it('uses tomorrow once the time has passed', () => {
    const now = atLocal(2026, 9, 11, 10, 0);

    expect(nextTimeOfDay(9 * 60, now)).toBe(atLocal(2026, 9, 12, 9, 0));
  });

  // An anchor created exactly at its own time must not be handed a fire time in
  // the past, which would fire (and wake the worker) immediately.
  it('uses tomorrow when the instant is exactly the time', () => {
    const now = atLocal(2026, 9, 11, 9, 0);

    expect(nextTimeOfDay(9 * 60, now)).toBe(atLocal(2026, 9, 12, 9, 0));
  });

  it('crosses a month boundary correctly', () => {
    const now = atLocal(2026, 9, 31, 23, 0);

    expect(nextTimeOfDay(9 * 60, now)).toBe(atLocal(2026, 10, 1, 9, 0));
  });
});

describe('isAnchoredAt', () => {
  const anchored = { scheduledTime: atLocal(2026, 9, 12, 9, 0), periodInMinutes: MINUTES_PER_DAY };

  it('accepts an alarm that fires at the configured time once a day', () => {
    expect(isAnchoredAt(anchored, 9 * 60)).toBe(true);
  });

  it('rejects a missing alarm', () => {
    expect(isAnchoredAt(undefined, 9 * 60)).toBe(false);
  });

  it('rejects a different period, which is a schedule from an older build', () => {
    expect(isAnchoredAt({ ...anchored, periodInMinutes: 360 }, 9 * 60)).toBe(false);
    expect(isAnchoredAt({ scheduledTime: anchored.scheduledTime }, 9 * 60)).toBe(false);
  });

  it('rejects an anchor at a different time of day', () => {
    expect(isAnchoredAt({ ...anchored, scheduledTime: atLocal(2026, 9, 12, 8, 0) }, 9 * 60)).toBe(false);
  });

  it('rejects an alarm with no scheduled time to read', () => {
    expect(isAnchoredAt({ periodInMinutes: MINUTES_PER_DAY }, 9 * 60)).toBe(false);
  });

  // What makes a locally-drifted anchor heal: the alarm is simply not recognised
  // any more, so the scheduler re-creates it at the configured time.
  it('rejects an anchor the clock moved off the configured time', () => {
    expect(isAnchoredAt({ ...anchored, scheduledTime: atLocal(2026, 9, 12, 10, 0) }, 9 * 60)).toBe(false);
  });
});
