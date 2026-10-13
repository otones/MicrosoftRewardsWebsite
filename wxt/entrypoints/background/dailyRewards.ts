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
// Give up waiting on the dashboard to load rather than leaving the promise
// pending forever when the tab is closed (by the user or by `finish`) or the
// load event never arrives.
const DASHBOARD_LOAD_TIMEOUT_MS = 30000;
// "complete" fires when the document has loaded, which on this SPA is still before
// its content script is guaranteed to have registered its listener. The first
// send therefore used to be dropped silently and never retried — the dashboard
// ran neither job and the run was written up as fine. Retry until the content
// script answers or the attempts run out.
const DASHBOARD_SEND_DELAY_MS = 300;
const DASHBOARD_SEND_ATTEMPTS = 12;
const DASHBOARD_SEND_RETRY_MS = 500;

// Sends the jobs to the dashboard until the content script acknowledges them.
//
// `tabs.sendMessage` rejects when nothing is listening yet, and the one-shot send
// this replaced swallowed that rejection — so on a page whose script registered a
// little late, the dashboard silently did nothing and the run was written up as
// fine. Retrying is what makes a late listener harmless; the bound stops a page
// that never loads a script from spinning.
async function sendRunDashboard(tabId: number, jobs: DashboardJobs): Promise<boolean> {
    for (let attempt = 0; attempt < DASHBOARD_SEND_ATTEMPTS; attempt++) {
        try {
            await browser.tabs.sendMessage(tabId, { action: 'runDashboard', ...jobs });
            return true;
        } catch {
            // No listener yet, or the tab went away. Wait, then try once more.
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
}

// Resolves with what the content script reported. The safety timer below closes
// the tab but has nothing to report, so it leaves the outcome empty rather than
// claiming success — which is how a silent failure used to look identical to a
// finished run.
export async function openDailyRewards(jobs: DashboardJobs): Promise<DashboardOutcome> {
    const previousActiveTabId = await getActiveTabId();

    const tab = await browser.tabs.create({ url: 'https://rewards.bing.com/dashboard', active: true });
    const dashboardId = tab.id!;
    // The `finish` timer below is the precise close; this is the backstop for
    // when the service worker is torn down before it ever fires.
    await trackTab(dashboardId, DAILY_TAB_MAX_LIFETIME_MS);

    function onCreated(created: { id?: number; openerTabId?: number }): void {
        if (created.openerTabId !== dashboardId || created.id == null) return;
        // Keep the dashboard foregrounded so it stays rendered and keeps
        // clicking; the search tab still loads in the background and credits.
        browser.tabs.update(dashboardId, { active: true }).catch(() => {});
        closeDailyTabAfterLoad(created.id);
    }
    browser.tabs.onCreated.addListener(onCreated);

    let outcome: DashboardOutcome = { dailySets: null, claimed: null, delivered: false };
    let done = false;
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
    }

    function doneListener(message: ReportedDone, sender: { tab?: { id?: number } }): void {
        if (message.action !== 'dashboardDone' || sender.tab?.id !== dashboardId) return;
        outcome = {
            dailySets: message.dailySets ?? null,
            claimed: message.claimed ?? null,
            delivered: true,
        };
        finish();
    }
    browser.runtime.onMessage.addListener(doneListener);
    setTimeout(finish, DAILY_TAB_MAX_LIFETIME_MS);

    await new Promise<void>((resolve) => {
        let isSettled = false;
        function settle(): void {
            if (isSettled) return;
            isSettled = true;
            browser.tabs.onUpdated.removeListener(loadListener);
            clearTimeout(giveUpTimer);
            resolve();
        }
        function loadListener(updatedId: number, changeInfo: { status?: string }): void {
            if (updatedId !== dashboardId || changeInfo.status !== 'complete') return;
            browser.tabs.onUpdated.removeListener(loadListener);
            setTimeout(() => {
                void sendRunDashboard(dashboardId, jobs).then((delivered) => {
                    if (delivered) outcome.delivered = true;
                });
                settle();
            }, DASHBOARD_SEND_DELAY_MS);
        }
        browser.tabs.onUpdated.addListener(loadListener);
        const giveUpTimer = setTimeout(settle, DASHBOARD_LOAD_TIMEOUT_MS);
    });

    // Reported only if the content script got far enough to send it; an empty
    // outcome means the dashboard never reported, which the caller records as an
    // unfinished run rather than a completed one.
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
