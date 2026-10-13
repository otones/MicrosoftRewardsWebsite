import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { trackTab, untrackTab } from './tabCleanup';

// The endpoint the dashboard itself calls to list the day's activities.
//
// This is read from the background rather than from the page because Edge refuses
// to run any script inside rewards.bing.com — declaratively or via
// `scripting.executeScript` — answering "The extensions gallery cannot be
// scripted". That leaves the dashboard's DOM unreachable from inside the browser,
// so the only route left is the API the page calls for its own data.
const USER_INFO_URL =
    'https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest';

// An activity link has to be given time to register before its tab closes, but not
// so long that a run with several activities drags on.
const ACTIVITY_LOAD_TIMEOUT_MS = 20000;
const ACTIVITY_MIN_LINGER_MS = 2500;
const ACTIVITY_MAX_LINGER_MS = 5000;
// A sane ceiling: the daily set is a handful of items, and a malformed response
// must not be able to open an unbounded number of tabs.
const MAX_ACTIVITIES_PER_RUN = 10;

export interface DailyOffer {
    offerId: string;
    title: string;
    destinationUrl: string;
    complete: boolean;
}

// Reads the daily set out of the API payload.
//
// The set has been seen keyed by date (an object of arrays) and, on some accounts,
// flattened into a single array; both are accepted so a server-side change shows up
// as items found rather than as a silent "no activities today". Entries without a
// destination are dropped: there would be nothing to visit.
export function parseDailyOffers(payload: unknown): DailyOffer[] {
    const block = (payload as { dailySetPromotions?: unknown } | null)?.dailySetPromotions;
    const raw: unknown[] = [];
    if (Array.isArray(block)) {
        raw.push(...block);
    } else if (block && typeof block === 'object') {
        for (const value of Object.values(block as Record<string, unknown>)) {
            if (Array.isArray(value)) raw.push(...value);
        }
    }

    const offers: DailyOffer[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const offer = entry as Record<string, unknown>;
        const destinationUrl = typeof offer.destinationUrl === 'string' ? offer.destinationUrl : '';
        if (!destinationUrl) continue;
        offers.push({
            offerId: typeof offer.offerId === 'string' ? offer.offerId : '',
            title: typeof offer.title === 'string' ? offer.title : '',
            destinationUrl,
            complete: offer.complete === true,
        });
    }
    return offers;
}

export interface ApiOffersResult {
    offers: DailyOffer[];
    error: string | null;
    // Top-level keys of the payload, kept so a response that parses to nothing can
    // say what it actually contained.
    keys: string[];
}

// `credentials: 'include'` is what makes this the user's own session; it is allowed
// because the manifest declares host permissions for rewards.bing.com.
export async function fetchDailyOffers(): Promise<ApiOffersResult> {
    try {
        const response = await fetch(USER_INFO_URL, {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok) return { offers: [], error: `HTTP ${response.status}`, keys: [] };
        const payload: unknown = await response.json();
        const keys =
            payload && typeof payload === 'object' ? Object.keys(payload as object).slice(0, 12) : [];
        return { offers: parseDailyOffers(payload), error: null, keys };
    } catch (error) {
        return { offers: [], error: describe(error), keys: [] };
    }
}

export interface ApiRunReport {
    // Activities that were still to do when the run started.
    found: number;
    // How many activity links were opened.
    clicked: number;
    // How many are still outstanding afterwards, or null when that could not be
    // read. Whether visiting a link is enough to credit it is the one assumption
    // this path makes, so it is measured rather than believed.
    pendingAfter: number | null;
    error: string | null;
    keys: string[];
}

// Completes the daily set without touching the dashboard: list the activities, then
// visit each outstanding one.
export async function runDailySetViaApi(): Promise<ApiRunReport> {
    const before = await fetchDailyOffers();
    if (before.error) {
        return { found: 0, clicked: 0, pendingAfter: null, error: before.error, keys: before.keys };
    }

    const pending = before.offers.filter((offer) => !offer.complete).slice(0, MAX_ACTIVITIES_PER_RUN);
    let clicked = 0;
    for (const offer of pending) {
        await openActivityTab(offer.destinationUrl);
        clicked++;
    }

    const after = await fetchDailyOffers();
    const pendingAfter = after.error ? null : after.offers.filter((offer) => !offer.complete).length;
    return {
        found: pending.length,
        clicked,
        pendingAfter,
        error: after.error,
        keys: before.keys,
    };
}

// Opens an activity in the background and closes it once it has loaded and had a
// moment to register. Mirrors the search tabs the rest of the run already opens.
async function openActivityTab(url: string): Promise<void> {
    const tab = await browser.tabs.create({ url, active: false });
    const tabId = tab.id;
    if (tabId == null) return;

    // Durability backstop: the listener and timer below are both lost if the
    // service worker is torn down, and the tab must not be left behind.
    await trackTab(tabId, ACTIVITY_LOAD_TIMEOUT_MS + ACTIVITY_MAX_LINGER_MS);

    await new Promise<void>((resolve) => {
        let settled = false;
        function done(): void {
            if (settled) return;
            settled = true;
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
        }
        function listener(updatedId: number, info: { status?: string }): void {
            if (updatedId === tabId && info.status === 'complete') done();
        }
        browser.tabs.onUpdated.addListener(listener);
        setTimeout(done, ACTIVITY_LOAD_TIMEOUT_MS);
    });

    await wait(getRndInteger(ACTIVITY_MIN_LINGER_MS, ACTIVITY_MAX_LINGER_MS));
    await browser.tabs.remove(tabId).catch(() => {});
    await untrackTab(tabId);
}

function describe(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, 160);
}
