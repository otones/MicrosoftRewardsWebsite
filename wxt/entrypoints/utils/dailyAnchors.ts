// Daily-set cards live in `div.grid > a`, mixed in with the dashboard's other
// cards. Matching on the *target* is what keeps the set correct.
//
// The pre-WXT build matched `href.includes("www.bing.com/search?q=")`, and that is
// what this restores. WXT replaced it with "the href carries a form/FORM tracking
// parameter", which is not unique to daily-set cards: the "refer a friend" card
// (`/referandearn?form=ML2X5V`) carries one too and comes earlier in the grid.
// Clicking that first opened an unrelated tab, took the foreground off the
// dashboard — whose cards only run their handlers while it is the visible tab —
// and the real activities behind it were never credited. Measured on a live
// dashboard: the form test matched 4 anchors (referral first), the search test
// matches the 3 activity cards and nothing else.
const BING_HOST_SUFFIX = 'bing.com';
const BING_SEARCH_PATH = '/search';
const QUERY_PARAM = 'q';

export function matchDailyAnchors(root: ParentNode): HTMLAnchorElement[] {
    return [...root.querySelectorAll<HTMLAnchorElement>('div.grid > a')]
        .filter(isBingSearch);
}

// A daily-set activity is always a Bing search: searches and quizzes alike point
// at `bing.com/search?q=...`, which is why the query parameter — not a tracking
// code the whole page shares — identifies them.
function isBingSearch(anchor: HTMLAnchorElement): boolean {
    let url: URL;
    try {
        url = new URL(anchor.href);
    } catch {
        // Not a URL at all (an in-page fragment, say): never a daily-set card.
        return false;
    }
    return (
        url.hostname.endsWith(BING_HOST_SUFFIX) &&
        url.pathname === BING_SEARCH_PATH &&
        url.searchParams.has(QUERY_PARAM)
    );
}
