import { browser } from 'wxt/browser';
import { getRndInteger } from '@/entrypoints/utils/helpers';
import { ClaimOutcome } from '@/entrypoints/utils/claimFlow';
import { DailySetOutcome, DashboardDoneMessage } from '@/entrypoints/types/dashboard';
import { trackTab, untrackTab } from './tabCleanup';

// Safety cap: close the dashboard tab even if the content script never reports
// done (page failed to render the daily sets, message dropped, etc.).
const DAILY_TAB_MAX_LIFETIME_MS = 90000;
// A daily-set search tab is closed a random few seconds after it finishes
// loading (so the search registers before we close it).
const DAILY_LINK_MIN_LINGER_MS = 2000;
const DAILY_LINK_MAX_LINGER_MS = 5000;
// Fallback: close a daily-set tab this long after it opened even if it never
// reports "complete".
const DAILY_LINK_HARD_CLOSE_MS = 20000;
// How long to keep offering the jobs to the dashboard's content script. Delivery
// is retried rather than tied to a load event: the script registers whenever the
// page finishes parsing it, which is not an instant this side can observe.
const DASHBOARD_SEND_TIMEOUT_MS = 30000;
const DASHBOARD_SEND_RETRY_MS = 400;

// Offers the jobs to the dashboard until its content script accepts them.
//
// This deliberately does NOT wait for the tab's "complete" event. That event is
// reported once and never replayed, so a listener attached a moment late misses it
// for good and the dashboard is never told to do anything — which is precisely how
// the daily activities went uncredited. `tabs.sendMessage` rejects while nothing is
// listening yet, which is the only reliable signal available, so the jobs are
// simply re-offered until they are taken (or the budget runs out).
async function sendRunDashboard(tabId: number, jobs: DashboardJobs): Promise<boolean> {
    const deadline = Date.now() + DASHBOARD_SEND_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            await browser.tabs.sendMessage(tabId, { action: 'runDashboard', ...jobs });
            return true;
        } catch {
            // Nothing listening yet, or the tab is gone. Try again shortly.
            await new Promise((resolve) => setTimeout(resolve, DASHBOARD_SEND_RETRY_MS));
        }
    }
    return false;
}

export interface DashboardJobs {
    doDailySet: boolean;
    doClaim: boolean;
}

// The `dashboardDone` message the content script sends back.
type ReportedDone = Partial<DashboardDoneMessage>;

// What the dashboard actually managed to do. The caller records this, so a run
// that found no cards, or whose clicks were refused, is not reported as a
// completed one.
export interface DashboardOutcome {
    dailySets: DailySetOutcome | null;
    claimed: ClaimOutcome | null;
    // False when the page never accepted the jobs at all. That is a different
    // failure from a page that ran them and found nothing to do, and only this
    // side can tell the two apart.
    delivered: boolean;
    // True once the content script accepted the jobs, whether or not it went on to
    // report a result. Distinguishes "never got the message" from "got it and said
    // nothing", which need different fixes.
    accepted: boolean;
}

// Resolves with what the content script reported. The safety timer below closes
// the tab but has nothing to report, so it leaves the outcome empty rather than
// claiming success — which is how a silent failure used to look identical to a
// finished run.
export async function openDailyRewards(jobs: DashboardJobs): Promise<DashboardOutcome> {
    const previousActiveTabId = await getActiveTabId();

    const tab = await browser.tabs.create({ url: 'https://rewards.bing.com/dashboard', active: true });
    const dashboardId = tab.id!;

    // `tabs.onCreated` goes on straight away, before any further await, so the
    // daily-set search tabs this dashboard opens are caught as they appear.
    function onCreated(created: { id?: number; openerTabId?: number }): void {
        if (created.openerTabId !== dashboardId || created.id == null) return;
        // Keep the dashboard foregrounded so it stays rendered and keeps
        // clicking; the search tab still loads in the background and credits.
        browser.tabs.update(dashboardId, { active: true }).catch(() => {});
        closeDailyTabAfterLoad(created.id);
    }
    browser.tabs.onCreated.addListener(onCreated);

    // The `finish` timer below is the precise close; this is the backstop for
    // when the service worker is torn down before it ever fires.
    await trackTab(dashboardId, DAILY_TAB_MAX_LIFETIME_MS);

    let outcome: DashboardOutcome = { dailySets: null, claimed: null, delivered: false, accepted: false };
    let done = false;
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
    });

    function finish(): void {
        if (done) return;
        done = true;
        browser.runtime.onMessage.removeListener(doneListener);
        browser.tabs.onCreated.removeListener(onCreated);
        browser.tabs.remove(dashboardId).catch(() => {});
        void untrackTab(dashboardId);
        if (previousActiveTabId != null) {
            browser.tabs.update(previousActiveTabId, { active: true }).catch(() => {});
        }
        resolveFinished();
    }

    function doneListener(message: ReportedDone, sender: { tab?: { id?: number } }): void {
        if (message.action !== 'dashboardDone' || sender.tab?.id !== dashboardId) return;
        outcome = {
            dailySets: message.dailySets ?? null,
            claimed: message.claimed ?? null,
            delivered: true,
            accepted: true,
        };
        finish();
    }
    browser.runtime.onMessage.addListener(doneListener);
    setTimeout(finish, DAILY_TAB_MAX_LIFETIME_MS);

    // Offer the jobs immediately. No load event gates this: `sendRunDashboard`
    // keeps re-offering until the content script is listening, which is the only
    // thing that actually has to be true before the dashboard can act.
    void sendRunDashboard(dashboardId, jobs).then((accepted) => {
        if (accepted) outcome.accepted = true;
        else finish();
    });

    await finished;

    // Filled in by the content script's reply; an empty outcome means the
    // dashboard never reported, which the caller records as an unfinished run
    // rather than a completed one.
    return outcome;
}

async function getActiveTabId(): Promise<number | undefined> {
    try {
        const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return tabs[0]?.id;
    } catch {
        return undefined;
    }
}

// Close a daily-set search tab a random few seconds after it finishes loading,
// with a hard cap in case it never reports "complete".
function closeDailyTabAfterLoad(tabId: number): void {
    void trackTab(tabId, DAILY_LINK_HARD_CLOSE_MS);
    let closed = false;
    function close(): void {
        if (closed) return;
        closed = true;
        browser.tabs.onUpdated.removeListener(loadListener);
        browser.tabs.get(tabId).then(() => browser.tabs.remove(tabId)).catch(() => {});
        void untrackTab(tabId);
    }
    function loadListener(updatedId: number, changeInfo: { status?: string }): void {
        if (updatedId === tabId && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(loadListener);
            setTimeout(close, getRndInteger(DAILY_LINK_MIN_LINGER_MS, DAILY_LINK_MAX_LINGER_MS));
        }
    }
    browser.tabs.onUpdated.addListener(loadListener);
    setTimeout(close, DAILY_LINK_HARD_CLOSE_MS);
}
