import { browser } from 'wxt/browser';
import { getRndInteger, wait } from '@/entrypoints/utils/helpers';
import { fetchWithSession } from './rewardsSession';
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
// The payload keys the set by date and carries **several days at once** — measured
// on a live account, it held today's three items (all complete) *and* tomorrow's
// three (all pending). Taking every entry would therefore open tomorrow's
// activities today, which credits nothing and looks like the extension acting on
// its own. Only the entry for the day the run is happening on is used.
//
// A flat array has also been seen on some accounts; when the set arrives that way
// there is no date to filter on, so it is taken as-is.
export function parseDailyOffers(payload: unknown, today: Date = new Date()): DailyOffer[] {
    const block = (payload as { dailySetPromotions?: unknown } | null)?.dailySetPromotions;
    const raw: unknown[] = [];
    if (Array.isArray(block)) {
        raw.push(...block);
    } else if (block && typeof block === 'object') {
        const entries = block as Record<string, unknown>;
        const todayKey = todayKeyFor(today);
        const chosen = entries[todayKey];
        if (Array.isArray(chosen)) {
            raw.push(...chosen);
        } else if (Object.keys(entries).length === 1) {
            // Exactly one key. Take it only when the key is *not* a date this code
            // can read: that means the format changed and filtering is impossible,
            // so dropping the day would be the worse error. A readable date that is
            // not today is rejected — otherwise the payload's next-day set (which is
            // present after the reset) would be completed a day early.
            const [onlyKey, onlyValue] = Object.entries(entries)[0];
            if (!isDateKey(onlyKey) && Array.isArray(onlyValue)) raw.push(...onlyValue);
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

// The keys are US-style `M/D/YYYY` (e.g. `10/15/2026`), built from local time
// because that is the day the user is living in.
export function todayKeyFor(date: Date): string {
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

// Recognises the endpoint's date keys, so an unreadable key can be told apart from
// one that is simply another day.
function isDateKey(key: string): boolean {
    return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(key);
}

export interface ApiOffersResult {
    offers: DailyOffer[];
    error: string | null;
    // Top-level keys of the payload, kept so a response that parses to nothing can
    // say what it actually contained.
    keys: string[];
}

// `credentials: 'include'` is not enough on its own: the session cookies are
// SameSite=Lax, so a cross-site request from the service worker leaves them behind
// and the endpoint answers 401. `fetchWithSession` attaches them explicitly via a
// temporary declarativeNetRequest rule (a `Cookie` header cannot be set from
// `fetch` itself — it is a forbidden header name).
export async function fetchDailyOffers(): Promise<ApiOffersResult> {
    const { result, cookieCount, error } = await fetchWithSession(USER_INFO_URL, async () => {
        const response = await fetch(USER_INFO_URL, {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as unknown;
    });

    if (error || result == null) {
        return { offers: [], error: `${error ?? 'no response'} (cookies: ${cookieCount})`, keys: [] };
    }
    const keys =
        result && typeof result === 'object' ? Object.keys(result as object).slice(0, 12) : [];
    return { offers: parseDailyOffers(result), error: null, keys };
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
