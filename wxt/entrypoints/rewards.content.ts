import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { matchDailyAnchors } from '@/entrypoints/utils/dailyAnchors';
import { claimPoints } from '@/entrypoints/utils/claimFlow';
import { waitForMatch } from '@/entrypoints/utils/waitForMatch';
import { oncePerPageRun } from '@/entrypoints/utils/oncePerPageRun';
import { DailySetOutcome, DashboardRequest } from '@/entrypoints/types/dashboard';

// The daily-set grid renders async. Bounded, like every wait here: a day with no
// set is an ordinary outcome, and an observer that is never disconnected keeps
// firing for the life of the page.
const DAILY_ANCHORS_TIMEOUT_MS = 20000;

export default defineContentScript({
    matches: ['https://rewards.bing.com/*'],
    main() {
        if (!oncePerPageRun('_marContentScriptInjected')) return;
        browser.runtime.onMessage.addListener((request: DashboardRequest) => {
            if (request.action === 'runDashboard') void runDashboard(request);
        });
    },
});

// Daily sets first: completing them can turn fresh points into claimable ones,
// so claiming afterwards picks those up in the same visit. Either job may be off,
// and either may find nothing to do.
//
// The outcome is reported rather than assumed. The background closes the tab on
// `dashboardDone` or on its own safety timer, and both used to count as success —
// so a day where the grid never rendered, or every click was refused, still
// recorded "ok" and the popup said the run had finished. `clicked`/`found` lets
// the background tell "did the work" from "found nothing" from "could not".
async function runDashboard({ doDailySet, doClaim }: DashboardRequest): Promise<void> {
    const dailySets = doDailySet ? await openDailySets() : null;
    const claimed = doClaim ? await claimPoints() : null;
    browser.runtime
        .sendMessage({ action: 'dashboardDone', dailySets, claimed })
        .catch(() => {});
}

async function openDailySets(): Promise<DailySetOutcome> {
    const anchors = await waitForMatch(() => {
        const found = matchDailyAnchors(document);
        return found.length > 0 ? found : null;
    }, DAILY_ANCHORS_TIMEOUT_MS);
    // No cards rendered within the window: an ordinary no-set day, but the caller
    // is told so it does not report a completed run.
    if (!anchors) return { found: 0, clicked: 0 };

    // Click each daily-set card so the dashboard's own handler registers the
    // activity — that click is what credits the points; opening the raw href
    // does not. Each click opens the search in a new tab, which the background
    // auto-closes.
    let clicked = 0;
    for (const anchor of anchors) {
        // The card can be detached between matching and clicking (the dashboard
        // re-renders), and a detached node's click does nothing.
        if (!anchor.isConnected) continue;
        anchor.click();
        clicked++;
        await wait(1000 + getRndInteger(0, 1000));
    }
    return { found: anchors.length, clicked };
}
