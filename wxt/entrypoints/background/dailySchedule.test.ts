// @vitest-environment node
// Background scheduling needs no DOM; node avoids the esbuild/jsdom clash that
// WXT's `#imports` transform triggers (same reason as searchRunner.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  checkLastOpened,
  handleDailyCheckAlarm,
  handleInstallOrUpdate,
  handleStartup,
  runRewards,
  scheduleDailyCheckAlarm,
} from './dailySchedule';
import { getStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULT_RUN_AT } from '@/entrypoints/utils/dailyRunTime';

const DASHBOARD_URL = 'https://rewards.bing.com/dashboard';

// The daily gate is time-of-day dependent now, so the tests that go through it
// pin the clock: anywhere past the default 09:00 anchor is "due", and 08:00 is
// "not yet due". Pinning also makes the day strings they compare against fixed.
const AFTER_ANCHOR = new Date(2026, 9, 11, 10, 30, 0);
const BEFORE_ANCHOR = new Date(2026, 9, 11, 8, 0, 0);

function localMinutesOf(instant: number): number {
  const at = new Date(instant);
  return at.getHours() * 60 + at.getMinutes();
}

function trackCreatedTabs(): string[] {
  const urls: string[] = [];
  vi.spyOn(fakeBrowser.tabs, 'create').mockImplementation(async (info: any) => {
    urls.push(String(info.url));
    return { id: urls.length } as any;
  });
  return urls;
}

// The daily-set run is deliberately fire-and-forget, so it is still mid-flight
// when runRewards resolves; let its pending work settle before asserting on tabs.
async function flushPendingWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// Settings roam with the profile; the run's own state is device-local, and the
// background reads the two from their own areas — so a seeded value has to land
// in the right one.
const RUN_STATE_KEYS = [
  'lastOpened',
  'lastRunAt',
  'lastRunOutcome',
  'lastRunError',
  'currentSearch',
  'isSearching',
];

async function seed(values: Record<string, unknown>): Promise<void> {
  const settings: Record<string, unknown> = { active: true, autoDaily: true, searches: 5, timeout: 60, closeTime: 5 };
  const runState: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (RUN_STATE_KEYS.includes(key)) runState[key] = value;
    else settings[key] = value;
  }
  await setStorageItems(settings, StorageValues.SYNC);
  if (Object.keys(runState).length > 0) await setStorageItems(runState, StorageValues.LOCAL);
}

describe('runRewards', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // The daily-set flow arms long safety timers that nothing in these tests
    // waits on; fake timers keep them from holding the run open.
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // Regression: runRewards used to `await openDailyRewards()`, whose load promise
  // only resolved on the dashboard tab reporting "complete". A dashboard closed by
  // the user, removed by our own safety timer, or lost to a torn-down MV3 service
  // worker left that promise pending forever, so startSearches was never reached
  // and not a single search ran all day.
  it('starts the searches even when the dashboard never reports "complete"', async () => {
    const urls = trackCreatedTabs();
    await seed({});

    await runRewards();
    await flushPendingWork();

    expect(urls).toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
    expect(await getStorageItem<boolean>('isSearching', StorageValues.LOCAL)).toBe(true);
  });

  it('opens no dashboard when "Daily set" is off, but still searches', async () => {
    const urls = trackCreatedTabs();
    await seed({ autoDaily: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).not.toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('runs no searches when "Daily searches" is off, but still opens the dashboard', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
    expect(await getStorageItem<boolean>('isSearching', StorageValues.LOCAL)).not.toBe(true);
  });

  // "Claim points" is the second job on the same dashboard tab, so it has to be
  // able to open that tab on its own — a user who only wants their points
  // claimed should not have to enable the daily set to get it.
  it('opens the dashboard for "Claim points" alone', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: true });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  // The dashboard is messaged through its content script, and that script can
  // register after the tab reports "complete" on a page this heavy. The send used
  // to happen once and swallow the rejection, so a slightly late listener meant
  // neither dashboard job ran and nothing was recorded. It now retries until the
  // page accepts.
  it('keeps trying to hand the jobs to the dashboard until it accepts them', async () => {
    const urls = trackCreatedTabs();
    const sendMessage = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
    // Two failed attempts, then the page's listener is up.
    sendMessage.mockRejectedValueOnce(new Error('no listener yet'));
    sendMessage.mockRejectedValueOnce(new Error('no listener yet'));
    await seed({ active: false, autoDaily: true });

    await runRewards();
    await flushPendingWork();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Every attempt must be the dashboard job, never a stray message.
    expect(sendMessage.mock.calls.every(([, msg]: any[]) => msg?.action === 'runDashboard')).toBe(true);
    expect(urls).toContain(DASHBOARD_URL);
  });

  // Regression: delivery used to be gated on the tab's "complete" event, which is
  // reported once and never replayed. A listener attached even slightly late missed
  // it for good, so the dashboard was never told to do anything and the daily
  // activities went uncredited while the run was recorded as fine. No load event at
  // all must still deliver.
  it('delivers the jobs with no tab "complete" event at all', async () => {
    trackCreatedTabs();
    const sendMessage = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
    await seed({ active: false, autoDaily: true });

    await runRewards();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sendMessage).toHaveBeenCalled();
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ action: 'runDashboard', doDailySet: true });
  });

  // Nothing is listening at all: the run must record that, not present itself as a
  // completed one. This is the shape the popup shows as a warning line.
  it('records that the dashboard never accepted the jobs', async () => {
    trackCreatedTabs();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    await seed({ active: false, autoDaily: true });

    await runRewards();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await getStorageItem<string>('lastRunNote', StorageValues.LOCAL)).toContain('没有接受任务指令');
  });

  // The dashboard took the message but never answered: a different failure from
  // never being reached, and it has its own note.
  it('records a delivery that was accepted but never answered', async () => {
    trackCreatedTabs();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    await seed({ active: false, autoDaily: true });

    await runRewards();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await getStorageItem<string>('lastRunNote', StorageValues.LOCAL)).toContain('收到了指令但没有回报结果');
  });

  // One tab covers both jobs: two would fight over the foreground, and the SPA
  // only renders while visible.
  it('opens a single dashboard when both dashboard jobs are on', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: true, claimPoints: true });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  it('opens nothing when every toggle is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: false });

    await runRewards();
    await flushPendingWork();

    expect(urls).toEqual([]);
  });
});

describe('handleStartup', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_ANCHOR);
  });
  afterEach(() => vi.useRealTimers());

  // The automatic daily run is the path users actually hit, so the "Daily set"
  // toggle has to be honoured there too, not just on the popup's button.
  it('opens no dashboard on the automatic daily run when "Daily set" is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: true, autoDaily: false });

    await handleStartup();
    await flushPendingWork();

    expect(urls).not.toContain(DASHBOARD_URL);
    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  it('opens the dashboard on the automatic daily run when "Daily set" is on', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: true });

    await handleStartup();
    await flushPendingWork();

    expect(urls).toEqual([DASHBOARD_URL]);
  });

  it('drops a tab registry left over from the previous session', async () => {
    // Both toggles off, so no run starts and re-registers tabs of its own.
    await seed({ active: false, autoDaily: false });
    await setStorageItems({ trackedTabs: { 7: 1 } }, StorageValues.LOCAL);

    await handleStartup();

    expect(await getStorageItem('trackedTabs', StorageValues.LOCAL)).toEqual({});
  });

  it('clears the run state a session that ended mid-run left behind', async () => {
    // Both toggles off, so the gate does nothing and only the reset is asserted.
    await seed({ active: false, autoDaily: false, isSearching: false, currentSearch: 3 });
    fakeBrowser.alarms.create('openTabAlarm', { delayInMinutes: 1 });

    await handleStartup();

    expect(await getStorageItem<number>('currentSearch', StorageValues.LOCAL)).toBe(0);
    expect(await fakeBrowser.alarms.get('openTabAlarm')).toBeUndefined();
  });

  // The catch-up in background.ts runs against this same worker instance on a
  // browser start, so it may have started today's run moments before this
  // handler. Cancelling that run here would strand it: one search done, the day
  // already marked.
  it('leaves a run that is already in flight alone', async () => {
    const yesterday = new Date(0).toLocaleDateString();
    await seed({ isSearching: true, currentSearch: 1, lastOpened: yesterday });
    fakeBrowser.alarms.create('openTabAlarm', { delayInMinutes: 1 });

    await handleStartup();
    await flushPendingWork();

    expect(await getStorageItem<boolean>('isSearching', StorageValues.LOCAL)).toBe(true);
    expect(await getStorageItem<number>('currentSearch', StorageValues.LOCAL)).toBe(1);
    expect(await fakeBrowser.alarms.get('openTabAlarm')).toBeDefined();
  });

  // The once-per-day gate used to only get re-checked on the next browser
  // restart; arming this alarm on startup is what lets it fire again on its own.
  it('arms the daily-check alarm when a daily feature is enabled', async () => {
    trackCreatedTabs();
    await seed({});

    await handleStartup();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  it('does not arm the daily-check alarm when every daily feature is off', async () => {
    trackCreatedTabs();
    await seed({ active: false, autoDaily: false });

    await handleStartup();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeUndefined();
  });
});

describe('handleInstallOrUpdate', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // "Open first result" navigates the search tab off the Bing results page, which
  // risks the search not being credited, so a fresh install must start with it off.
  it('seeds a new install with "open first result" disabled', async () => {
    await handleInstallOrUpdate({ reason: 'install' });

    expect(await getStorageItem<boolean>('openFirstResult', StorageValues.SYNC)).toBe(false);
  });

  // Claiming clicks through a real transaction on the account, so it is opt-in:
  // a fresh install must not start out pressing it.
  it('seeds a new install with "claim points" disabled', async () => {
    await handleInstallOrUpdate({ reason: 'install' });

    expect(await getStorageItem<boolean>('claimPoints', StorageValues.SYNC)).toBe(false);
  });

  // The time of day is a setting like any other, so a fresh install has to carry
  // the shipped default rather than leaving the scheduler to guess.
  it('seeds a new install with the default run time', async () => {
    await handleInstallOrUpdate({ reason: 'install' });

    expect(await getStorageItem<string>('runAtTime', StorageValues.SYNC)).toBe(DEFAULT_RUN_AT);
  });

  // This fork is the extension alone: installing must not open the upstream
  // author's site, and uninstalling must not report anywhere.
  it('opens no tab and sets no uninstall URL on install', async () => {
    const urls = trackCreatedTabs();
    const uninstall = vi.spyOn(fakeBrowser.runtime, 'setUninstallURL');

    await handleInstallOrUpdate({ reason: 'install' });
    // The old build opened that tab on a 1s timer, so let one land before asserting.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(urls).toEqual([]);
    expect(uninstall).not.toHaveBeenCalled();
  });
});

describe('scheduleDailyCheckAlarm', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // The alarm is anchored to the configured local time, so the clock has to be
    // fixed for its scheduledTime to be predictable.
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_ANCHOR);
  });
  afterEach(() => vi.useRealTimers());

  it('arms the alarm while a daily feature is enabled', async () => {
    await seed({});

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  // "Claim points" alone (no daily set, no daily searches) still needs the
  // once-per-day gate to run, so it has to arm the alarm on its own too.
  it('arms the alarm when only "Claim points" is enabled', async () => {
    await seed({ active: false, autoDaily: false, claimPoints: true });

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeDefined();
  });

  // Regression: an alarm left armed from before the user disabled every daily
  // feature would keep waking the worker for nothing.
  it('clears an existing alarm once every daily feature is off', async () => {
    await seed({ active: false, autoDaily: false, claimPoints: false });
    fakeBrowser.alarms.create('dailyCheck', { periodInMinutes: 1440 });

    await scheduleDailyCheckAlarm();

    expect(await fakeBrowser.alarms.get('dailyCheck')).toBeUndefined();
  });

  // What the user asked for: the run is due at a time of day, not "whenever the
  // worker happens to wake first".
  it('anchors the alarm at the configured local time, once a day', async () => {
    await seed({ runAtTime: '09:00' });

    await scheduleDailyCheckAlarm();

    const alarm = await fakeBrowser.alarms.get('dailyCheck');
    expect(alarm?.periodInMinutes).toBe(1440);
    // 10:30 now, so the next 09:00 is tomorrow's.
    expect(alarm?.scheduledTime).toBe(new Date(2026, 9, 12, 9, 0, 0, 0).getTime());
  });

  it('anchors the alarm at whatever time is configured', async () => {
    await seed({ runAtTime: '18:30' });

    await scheduleDailyCheckAlarm();

    const alarm = await fakeBrowser.alarms.get('dailyCheck');
    expect(alarm?.scheduledTime).toBe(new Date(2026, 9, 11, 18, 30, 0, 0).getTime());
  });

  // Regression: alarms.create() CLEARS an alarm whose name already exists and
  // replaces it, which restarts its countdown. As this runs on every
  // service-worker start, the unconditional create it used to do pushed the daily
  // check back every time the worker woke — the popup, a settings change, a run —
  // so it could go days without firing once. The clock is moved between the two
  // calls so a re-create would be visible as a shifted scheduledTime.
  it('leaves an armed alarm alone instead of restarting its countdown', async () => {
    await seed({});
    await scheduleDailyCheckAlarm();
    const before = (await fakeBrowser.alarms.get('dailyCheck'))?.scheduledTime;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await scheduleDailyCheckAlarm();

    const after = await fakeBrowser.alarms.get('dailyCheck');
    expect(after?.scheduledTime).toBe(before);
    expect(after?.periodInMinutes).toBe(1440);
  });

  // Changing the time has to take effect now, not at the next worker start.
  it('re-anchors the alarm when the configured time changes', async () => {
    await seed({ runAtTime: '09:00' });
    await scheduleDailyCheckAlarm();

    await seed({ runAtTime: '18:30' });
    await scheduleDailyCheckAlarm();

    const alarm = await fakeBrowser.alarms.get('dailyCheck');
    expect(alarm?.scheduledTime).toBe(new Date(2026, 9, 11, 18, 30, 0, 0).getTime());
  });

  // A 24-hour period drifts an hour in local time across a DST shift. Without
  // this the alarm would fire at 08:00 for a 09:00 anchor, the gate would refuse
  // (not due yet) and the run would never happen again.
  it('re-anchors an alarm whose phase the clock moved', async () => {
    await seed({ runAtTime: '09:00' });
    fakeBrowser.alarms.create('dailyCheck', {
      when: new Date(2026, 9, 12, 10, 0, 0, 0).getTime(),
      periodInMinutes: 1440,
    });

    await scheduleDailyCheckAlarm();

    const alarm = await fakeBrowser.alarms.get('dailyCheck');
    expect(alarm?.scheduledTime).toBe(new Date(2026, 9, 12, 9, 0, 0, 0).getTime());
  });

  // An alarm from an older build carries a different period and cannot be trusted
  // to fire at the configured time.
  it('replaces an alarm armed by an older build with a different period', async () => {
    await seed({ runAtTime: '09:00' });
    fakeBrowser.alarms.create('dailyCheck', { periodInMinutes: 360 });

    await scheduleDailyCheckAlarm();

    const alarm = await fakeBrowser.alarms.get('dailyCheck');
    expect(alarm?.periodInMinutes).toBe(1440);
    expect(localMinutesOf(alarm!.scheduledTime)).toBe(9 * 60);
  });
});

describe('checkLastOpened', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_ANCHOR);
  });
  afterEach(() => vi.useRealTimers());

  // The catch-up in background.ts re-runs this gate on every service-worker
  // start. That is the trigger which covers the sessions the other two cannot:
  // a browser that is never fully restarted (onStartup never fires) and an alarm
  // that a restart cleared or the device sleeping delayed.
  it('runs the daily tasks when the worker wakes on a new day', async () => {
    const urls = trackCreatedTabs();
    await seed({ lastOpened: new Date(0).toLocaleDateString() });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBe(new Date().toLocaleDateString());
  });

  // The point of the setting: the run is due at a time of day, so it must not
  // start in the middle of the night just because the worker happened to wake.
  it('does nothing before the configured time', async () => {
    const urls = trackCreatedTabs();
    vi.setSystemTime(BEFORE_ANCHOR);
    await seed({});

    await checkLastOpened();
    await flushPendingWork();

    expect(urls).toEqual([]);
    // Unmarked, so it still runs once the time comes.
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBeNull();
  });

  it('waits for a configured time that is later than the default', async () => {
    const urls = trackCreatedTabs();
    await seed({ runAtTime: '14:00', lastOpened: new Date(0).toLocaleDateString() });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls).toEqual([]);
  });

  // A value that cannot be read must not leave the run with no time of day at all.
  it('falls back to the default time when the stored one is unreadable', async () => {
    const urls = trackCreatedTabs();
    await seed({ runAtTime: 'not a time', lastOpened: new Date(0).toLocaleDateString() });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  // A machine asleep at the configured time, or a browser closed then, still gets
  // the day: the gate is "due, and not yet run", not "exactly on time".
  it('runs at the first wake after the configured time', async () => {
    const urls = trackCreatedTabs();
    vi.setSystemTime(new Date(2026, 9, 11, 23, 45, 0));
    await seed({ runAtTime: '09:00', lastOpened: new Date(0).toLocaleDateString() });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  // The catch-up fires on every wake and a run writes storage constantly, so a
  // run must not be restarted by its own side effects.
  it('does not start a second run while one is still in flight', async () => {
    const urls = trackCreatedTabs();
    const yesterday = new Date(0).toLocaleDateString();
    await seed({ isSearching: true, currentSearch: 1, lastOpened: yesterday });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls).toEqual([]);
    // Left unmarked on purpose: the run in flight is the one that will mark it.
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBe(yesterday);
  });

  it('marks the day and records the result once a run succeeds', async () => {
    trackCreatedTabs();
    await seed({});

    await checkLastOpened();
    await flushPendingWork();

    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBe(new Date().toLocaleDateString());
    expect(await getStorageItem<string>('lastRunOutcome', StorageValues.LOCAL)).toBe('ok');
  });

  // The day must stay unmarked when a run throws, or one failure would write off
  // the rest of the day; the error is kept so the popup can say what happened.
  it('records the failure and leaves the day unmarked when a run throws', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('no window'));
    // Searches only: the dashboard run is fire-and-forget and swallows its own
    // errors, so it could not surface this.
    await seed({ autoDaily: false });

    await checkLastOpened();
    await flushPendingWork();

    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBeNull();
    expect(await getStorageItem<string>('lastRunOutcome', StorageValues.LOCAL)).toBe('failed');
    expect(await getStorageItem<string>('lastRunError', StorageValues.LOCAL)).toBe('no window');
  });

  // Regression: with the day on storage.sync, a run on one machine marked the day
  // done on every other machine the profile synced to, which left those needing
  // the popup button. The device's own record is what counts.
  it('runs even when a synced copy says today has already run', async () => {
    const urls = trackCreatedTabs();
    await setStorageItems({ lastOpened: new Date().toLocaleDateString() }, StorageValues.SYNC);
    await seed({ lastOpened: new Date(0).toLocaleDateString() });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls.some((url) => url.startsWith('https://www.bing.com/search?q='))).toBe(true);
  });

  // A day left on sync by an older build is adopted once, so upgrading does not
  // re-run a day that already ran.
  it('adopts a day left on sync storage by an older build', async () => {
    const urls = trackCreatedTabs();
    const today = new Date().toLocaleDateString();
    await setStorageItems({ lastOpened: today }, StorageValues.SYNC);
    await seed({});

    await checkLastOpened();
    await flushPendingWork();

    expect(urls).toEqual([]);
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBe(today);
    expect(await getStorageItem<string>('lastOpened', StorageValues.SYNC)).toBeNull();
  });

  it('leaves the day unmarked when every daily feature is off', async () => {
    const urls = trackCreatedTabs();
    await seed({ active: false, autoDaily: false, claimPoints: false });

    await checkLastOpened();
    await flushPendingWork();

    expect(urls).toEqual([]);
    // Unmarked, so switching a feature on later today still gets a run.
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBeNull();
  });

  // This is called at the top level of every worker start, so it must not reject:
  // an unhandled rejection there is invisible, and the day would look idle with no
  // record of why nothing happened.
  it('never rejects, even when reading storage fails', async () => {
    await seed({});
    vi.spyOn(fakeBrowser.storage.local, 'get').mockRejectedValueOnce(new Error('storage offline'));

    await expect(checkLastOpened()).resolves.toBeUndefined();
    expect(await getStorageItem<string>('lastRunOutcome', StorageValues.LOCAL)).toBe('failed');
    expect(await getStorageItem<string>('lastRunError', StorageValues.LOCAL)).toBe('storage offline');
  });
});

describe('handleDailyCheckAlarm', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(AFTER_ANCHOR);
  });
  afterEach(() => vi.useRealTimers());

  it('ignores alarms it does not own', async () => {
    const urls = trackCreatedTabs();
    await seed({ lastOpened: 'not a real date' });

    await handleDailyCheckAlarm({ name: 'someOtherAlarm' });
    await flushPendingWork();

    expect(urls).toEqual([]);
  });

  // This is the case a browser session that spans midnight without a restart
  // used to miss entirely: nothing but a restart ever re-ran checkLastOpened.
  it('runs the daily tasks once the date has rolled over since the last run', async () => {
    const urls = trackCreatedTabs();
    await seed({ lastOpened: new Date(0).toLocaleDateString() });

    await handleDailyCheckAlarm({ name: 'dailyCheck' });
    await flushPendingWork();

    expect(urls).toContain(DASHBOARD_URL);
    expect(await getStorageItem<string>('lastOpened', StorageValues.LOCAL)).toBe(new Date().toLocaleDateString());
  });

  it('does nothing when today has already run', async () => {
    const urls = trackCreatedTabs();
    await seed({ lastOpened: new Date().toLocaleDateString() });

    await handleDailyCheckAlarm({ name: 'dailyCheck' });
    await flushPendingWork();

    expect(urls).toEqual([]);
  });
});
