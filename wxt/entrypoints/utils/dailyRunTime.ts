// The local time of day the automatic run is due at, and the alarm anchor built
// from it.
//
// A time of day is handled as minutes since local midnight and turned into an
// instant from local date parts, never by adding a 24-hour span: across a DST
// shift a "every 24 hours" alarm lands an hour off in local time, and since the
// gate below only runs once the configured time has passed, a run whose anchor
// drifted *later* than its fire time would never come due at all. `isAnchoredAt`
// is what notices that and re-anchors.

export const MINUTES_PER_DAY = 24 * 60;

// 09:00 — morning, so the day's points are in before the day is used.
export const DEFAULT_RUN_AT_MINUTES = 9 * 60;

export function formatTimeOfDay(minutesOfDay: number): string {
    const hours = Math.floor(minutesOfDay / 60);
    const minutes = minutesOfDay % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// Derived rather than written twice, so the shipped default and the popup field
// cannot drift apart.
export const DEFAULT_RUN_AT = formatTimeOfDay(DEFAULT_RUN_AT_MINUTES);

// Accepts what an <input type="time"> produces ("09:00", and "09:00:00" on a
// browser that includes seconds) plus the sloppy "9:00" someone could have stored
// by hand. Anything else is null and the caller falls back to the default, so a
// corrupt value cannot leave the run with no time at all.
export function parseTimeOfDay(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

// Today's occurrence of that local time.
export function timeOfDayToday(minutesOfDay: number, now: number = Date.now()): number {
    return localInstant(new Date(now), minutesOfDay);
}

// The next occurrence strictly after `now`: today's while it is still ahead,
// otherwise tomorrow's. "Strictly" matters for an alarm anchor — one created
// exactly at its own time would otherwise be served a fire time in the past.
export function nextTimeOfDay(minutesOfDay: number, now: number = Date.now()): number {
    const today = timeOfDayToday(minutesOfDay, now);
    if (today > now) return today;
    const at = new Date(today);
    return localInstant(new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1), minutesOfDay);
}

// Built from local date parts so the result is always that clock time on that
// local day, whatever the offset does.
function localInstant(day: Date, minutesOfDay: number): number {
    return new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(minutesOfDay / 60),
        minutesOfDay % 60,
        0,
        0
    ).getTime();
}

// Whether an armed alarm already fires at the configured local time, once a day.
//
// This is how the scheduler recognises its own alarm. Creating an alarm whose name
// exists clears it and replaces it, restarting its countdown, and the scheduler
// runs on every worker start — so re-creating blindly could push the run back
// every time the worker woke. Reading the intent back off the alarm (rather than
// remembering it in storage) also lets a drifted anchor heal itself.
export function isAnchoredAt(
    alarm: { scheduledTime?: number; periodInMinutes?: number } | undefined,
    minutesOfDay: number
): boolean {
    if (!alarm || alarm.periodInMinutes !== MINUTES_PER_DAY) return false;
    if (typeof alarm.scheduledTime !== 'number') return false;
    const at = new Date(alarm.scheduledTime);
    return at.getHours() * 60 + at.getMinutes() === minutesOfDay;
}
