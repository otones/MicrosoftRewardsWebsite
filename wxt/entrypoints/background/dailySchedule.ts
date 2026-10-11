import { storage } from '#imports';
import { browser } from 'wxt/browser';
import { getStorageItem, getStorageItems, setStorageItem, setStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import {
    DEFAULT_RUN_AT_MINUTES,
    MINUTES_PER_DAY,
    isAnchoredAt,
    nextTimeOfDay,
    parseTimeOfDay,
    timeOfDayToday,
} from '@/entrypoints/utils/dailyRunTime';
import { toInt } from '@/entrypoints/utils/search';
import { DEFAULTS } from '@/entrypoints/utils/settings';
import { setBadgeText } from '@/entrypoints/utils/browserAction';
import { openDailyRewards } from './dailyRewards';
import { startSearches, stopSearches } from './searchRunner';
import { clearTrackedTabs } from './tabCleanup';

const WEBSITE_URL = 'https://svitspindler.com/microsoft-automatic-rewards';

const DAILY_CHECK_ALARM = 'dailyCheck';

// Bounded so a pathological error message cannot fill storage.
const MAX_RECORDED_ERROR_LENGTH = 200;

interface DailyFeatureToggles {
    isSearchesEnabled: boolean;
    isDailySetEnabled: boolean;
    isClaimEnabled: boolean;
}

// The time of day the run is due at, falling back to the shipped default when the
// stored value is missing or unreadable.
async function readRunAtMinutes(): Promise<number> {
    const stored = await getStorageItem<string>('runAtTime', StorageValues.SYNC);
    return parseTimeOfDay(stored) ?? DEFAULT_RUN_AT_MINUTES;
}

// One reader for all three triggers below, so they cannot drift on what
// "enabled" means — and every value falls back to DEFAULTS, which the browser
// start gate used to skip (a missing `autoDaily` read as off there, while the
// alarm and runRewards both treated it as on).
async function readDailyFeatureToggles(): Promise<DailyFeatureToggles> {
    const s = await getStorageItems(['active', 'autoDaily', 'claimPoints'], StorageValues.SYNC);
    return {
        isSearchesEnabled: s.active ?? DEFAULTS.active,
        isDailySetEnabled: s.autoDaily ?? DEFAULTS.autoDaily,
        isClaimEnabled: s.claimPoints ?? DEFAULTS.claimPoints,
    };
}

function isAnyDailyFeatureEnabled(toggles: DailyFeatureToggles): boolean {
    return toggles.isSearchesEnabled || toggles.isDailySetEnabled || toggles.isClaimEnabled;
}

// Runs whatever the user has enabled: the dashboard visit if "Daily set" or
// "Claim points" is on, and the Bing searches if "Daily searches" is on. Both
// the automatic daily trigger and the popup's "Get rewards" button call this, so
// the button respects the same toggles rather than forcing either run.
export async function runRewards(): Promise<void> {
    const s = await getStorageItems(
        ['searches', 'timeout', 'closeTime', 'active', 'autoDaily', 'claimPoints'],
        StorageValues.SYNC
    );
    const searchTimeout = toInt(s.timeout, DEFAULTS.timeout);
    const searches = toInt(s.searches, DEFAULTS.searches);
    const closeTime = toInt(s.closeTime, DEFAULTS.closeTime);
    const isDailySetEnabled = s.autoDaily ?? DEFAULTS.autoDaily;
    const isClaimEnabled = s.claimPoints ?? DEFAULTS.claimPoints;
    const isSearchesEnabled = s.active ?? DEFAULTS.active;

    // The dashboard visit is deliberately NOT awaited: the two runs are
    // independent. Awaiting it used to serialise the searches behind the
    // dashboard tab reporting "complete", so a dashboard closed by the user,
    // removed by our own safety timer, or lost to a torn-down service worker
    // meant not a single search ran that day. One tab covers both dashboard
    // jobs — two would fight over the foreground, and the SPA only renders while
    // it is visible.
    if (isDailySetEnabled || isClaimEnabled) {
        void openDailyRewards({
            doDailySet: isDailySetEnabled,
            doClaim: isClaimEnabled,
        }).catch(() => {});
    }
    if (isSearchesEnabled && searches > 0) {
        await startSearches(searchTimeout, searches, closeTime);
    }
}

// Guards the gate against running twice at once. The catch-up below fires on
// every worker wake, and a run writes storage constantly — each write wakes the
// worker again, so without this a run in flight could be restarted by its own
// side effects. (The storage flag inside runDailyCheck covers the same race
// across a worker teardown, where this module state is gone.)
let dailyCheckInFlight: Promise<void> | null = null;

// The once-per-calendar-day gate, and the single place that decides whether
// today's run still has to happen. Called from three triggers on purpose, because
// each one alone leaves a hole: browser start (no event at all for a session that
// straddles midnight), the recurring alarm (can be cleared by a restart, or fire
// very late after the device slept) and the catch-up on every worker start (only
// happens when something else wakes the worker).
export function checkLastOpened(): Promise<void> {
    if (dailyCheckInFlight) return dailyCheckInFlight;
    const inFlight = runDailyCheck().finally(() => {
        dailyCheckInFlight = null;
    });
    dailyCheckInFlight = inFlight;
    return inFlight;
}

async function runDailyCheck(): Promise<void> {
    try {
        await attemptDailyRun();
    } catch (error) {
        // Never rejects. This runs from three event paths that have nowhere to
        // report to — including a call at the top level of every worker start —
        // where a rejection would surface only as an unhandled one in the service
        // worker console. The failure is recorded for the popup instead.
        await recordRunFailure(error);
    }
}

async function attemptDailyRun(): Promise<void> {
    const toggles = await readDailyFeatureToggles();
    // Nothing enabled: leave the day unmarked rather than writing it off, so
    // turning a feature on later today still gets a run.
    if (!isAnyDailyFeatureEnabled(toggles)) return;

    // A run already in flight must not be started again. Deliberately not marking
    // the day here either: the running one will mark it when it finishes.
    if ((await getStorageItem<boolean>('isSearching', StorageValues.LOCAL)) === true) return;

    // Due at the configured local time, and then at the first wake after it — that
    // "after it" is what covers a machine that was asleep, or a browser that was
    // closed, at the moment the run came due. Before it is due nothing happens:
    // not running in the middle of the night is the point of the setting.
    const runAtMinutes = await readRunAtMinutes();
    const now = Date.now();
    if (now < timeOfDayToday(runAtMinutes, now)) return;

    const today = new Date(now).toLocaleDateString();
    if ((await readLastOpened()) === today) return;

    await setStorageItems(
        { lastRunAt: Date.now(), lastRunOutcome: 'started', lastRunError: null },
        StorageValues.LOCAL
    );

    try {
        await runRewards();
    } catch (error) {
        // Leave `lastOpened` stale so the next wake retries instead of writing
        // off the day.
        await recordRunFailure(error);
        return;
    }

    await setStorageItem('lastRunOutcome', 'ok', StorageValues.LOCAL);
    // Marked last, on purpose: a crash between here and the end of the run leaves
    // the day unmarked and the next wake runs it again. A duplicate run costs
    // points-neutral tabs; a day written off costs the day.
    await setStorageItem('lastOpened', today, StorageValues.LOCAL);
}

// Swallows its own failure: when storage is what is broken there is nowhere left
// to record that, and throwing here would only skip the day silently.
async function recordRunFailure(error: unknown): Promise<void> {
    try {
        await setStorageItems(
            { lastRunOutcome: 'failed', lastRunError: toErrorText(error) },
            StorageValues.LOCAL
        );
    } catch {
        // Nothing more this path can do.
    }
}

// `lastOpened` counts the days *this device* has run, so it belongs on local
// storage: on sync, a run on one machine marked the day done on every other
// machine signed into the same profile, leaving those needing the popup button.
// A value left on sync by an older build is adopted once, so the upgrade does not
// re-run a day that already ran.
async function readLastOpened(): Promise<string | null> {
    const local = await getStorageItem<string>('lastOpened', StorageValues.LOCAL);
    if (local != null) return local;

    const legacy = await getStorageItem<string>('lastOpened', StorageValues.SYNC);
    if (legacy == null) return null;

    await setStorageItem('lastOpened', legacy, StorageValues.LOCAL);
    await storage.removeItem('sync:lastOpened');
    return legacy;
}

function toErrorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, MAX_RECORDED_ERROR_LENGTH);
}

export function isDailyCheckAlarm(name: string): boolean {
    return name === DAILY_CHECK_ALARM;
}

// Armed only while at least one daily feature is on, so a fully disabled
// extension is not woken for nothing — the same discipline tabCleanup uses for its
// sweep alarm.
//
// The alarm is the only trigger that works when nothing else does: onStartup never
// fires for a browser that is never restarted, and the catch-up on a worker start
// needs something else to wake the worker. One alarm, anchored to the configured
// local time, every 24 hours.
//
// Creating an alarm whose name already exists CLEARS it and replaces it, which
// restarts its countdown. This runs on every worker start, so an unconditional
// create pushed the run back every time the worker woke — the popup, a settings
// change, a run — and it could go days without firing. Hence the anchor check
// instead: create only when the armed alarm does not already mean what we want,
// which is also what re-anchors an alarm the clock moved (a DST shift).
export async function scheduleDailyCheckAlarm(): Promise<void> {
    const toggles = await readDailyFeatureToggles();
    if (!isAnyDailyFeatureEnabled(toggles)) {
        await browser.alarms.clear(DAILY_CHECK_ALARM);
        return;
    }

    const runAtMinutes = await readRunAtMinutes();
    const existing = await browser.alarms.get(DAILY_CHECK_ALARM);
    if (isAnchoredAt(existing, runAtMinutes)) return;

    browser.alarms.create(DAILY_CHECK_ALARM, {
        when: nextTimeOfDay(runAtMinutes),
        periodInMinutes: MINUTES_PER_DAY,
    });
}

export async function handleDailyCheckAlarm(alarm: { name: string }): Promise<void> {
    if (alarm.name !== DAILY_CHECK_ALARM) return;
    await checkLastOpened();
}

// Re-arms (or disarms, or re-anchors) the alarm the moment a setting that shapes
// it changes — the feature toggles or the time of day — so the change takes effect
// immediately rather than at the next worker start, including a value synced in
// from another device.
export function watchDailyFeatureToggles(): void {
    storage.watch<boolean>('sync:active', () => void scheduleDailyCheckAlarm());
    storage.watch<boolean>('sync:autoDaily', () => void scheduleDailyCheckAlarm());
    storage.watch<boolean>('sync:claimPoints', () => void scheduleDailyCheckAlarm());
    storage.watch<string>('sync:runAtTime', () => void scheduleDailyCheckAlarm());
}

export async function handleInstallOrUpdate(details: { reason: string }): Promise<void> {
    if (details.reason === 'install') {
        await setStorageItems({
            active: DEFAULTS.active,
            autoDaily: DEFAULTS.autoDaily,
            accountLevel: DEFAULTS.accountLevel,
            timeout: DEFAULTS.timeout,
            searches: DEFAULTS.searches,
            closeTime: DEFAULTS.closeTime,
            openFirstResult: DEFAULTS.openFirstResult,
            claimPoints: DEFAULTS.claimPoints,
            runAtTime: DEFAULTS.runAtTime,
        }, StorageValues.SYNC);
        // Run state is device-local, so it is seeded on local storage.
        await setStorageItems({ isSearching: false, currentSearch: 0 }, StorageValues.LOCAL);
        await browser.runtime.setUninstallURL(
            `https://svitspindler.com/uninstall?extension=${encodeURI('Microsoft Automatic Rewards')}`
        );
        setTimeout(() => { browser.tabs.create({ url: WEBSITE_URL, active: true }); }, 1000);
    } else if (details.reason === 'update') {
        setBadgeText('New');
    }
}

export async function handleStartup(): Promise<void> {
    // A search run never survives a browser restart, so its state is cleared —
    // but only when no run is under way. On a browser start the catch-up in
    // background.ts runs against this same worker instance and may already have
    // started today's run; clearing that run's alarm here would strand it with the
    // day marked and a single search done. A run this instance started has already
    // written the flag, and one it has not started yet is unaffected by a clear.
    const isRunInFlight = (await getStorageItem<boolean>('isSearching', StorageValues.LOCAL)) === true;
    if (!isRunInFlight) {
        await stopSearches();
        await setStorageItems({ currentSearch: 0 }, StorageValues.LOCAL);
    }
    // Tab ids do not survive a browser restart, so anything still registered for
    // cleanup points at tabs that no longer exist.
    await clearTrackedTabs();
    // The enabled-feature gate lives inside checkLastOpened, so a browser start
    // and the catch-up on a plain worker wake go through one decision.
    await checkLastOpened();
    await scheduleDailyCheckAlarm();
}
