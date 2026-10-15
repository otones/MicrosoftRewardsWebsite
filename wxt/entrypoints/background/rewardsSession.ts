import { browser } from 'wxt/browser';

// Microsoft Rewards' session cookies are SameSite=Lax (verified on this machine:
// `.MSA.Auth` is Lax, and the auth cookies on rewards.bing.com itself carry no
// SameSite at all, which defaults to Lax). A `fetch` from the extension's service
// worker is cross-site, so the browser withholds them and the API answers 401 —
// which is exactly what the first version of this fallback hit.
//
// Two facts make that fixable:
//   * `browser.cookies` reads the values *inside* the browser, so it does not care
//     that Edge encrypts them with App-Bound encryption (`v20`), which no offline
//     reader can decrypt.
//   * `fetch` refuses a `Cookie` request header (it is a forbidden header name),
//     but `declarativeNetRequest` may set request headers on the extension's own
//     requests, which is the documented way to attach one.
const RULE_ID = 9317;

// Both the host-scoped and the domain-wide cookies apply to rewards.bing.com, so
// both sets have to travel.
const COOKIE_DOMAINS = ['rewards.bing.com', '.bing.com'];

export async function readSessionCookieHeader(url: string): Promise<string | null> {
    try {
        const cookies = await browser.cookies.getAll({ url });
        if (!cookies.length) return null;
        // Longest-lived first is irrelevant; order does not matter to the server,
        // but duplicates must not appear.
        const seen = new Set<string>();
        const parts: string[] = [];
        for (const cookie of cookies) {
            if (seen.has(cookie.name)) continue;
            seen.add(cookie.name);
            parts.push(`${cookie.name}=${cookie.value}`);
        }
        return parts.length ? parts.join('; ') : null;
    } catch {
        // Without the permission this throws; returning null lets the caller report
        // the resulting 401 rather than crashing the run.
        return null;
    }
}

async function installCookieRule(urlFilter: string, cookieHeader: string): Promise<void> {
    await browser.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [RULE_ID],
        addRules: [
            {
                id: RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'cookie', operation: 'set', value: cookieHeader }],
                },
                condition: {
                    urlFilter,
                    resourceTypes: ['xmlhttprequest'],
                },
            },
        ],
    });
}

async function removeCookieRule(): Promise<void> {
    try {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
    } catch {
        // A rule that is already gone is not an error worth failing a run over.
    }
}

// Runs `send` with the session cookies attached.
//
// The rule is installed per call and always removed afterwards, so the extension
// never carries a live credential around: session rules are also cleared by the
// browser on shutdown, which bounds the exposure further.
export async function fetchWithSession<T>(
    url: string,
    send: () => Promise<T>
): Promise<{ result: T | null; cookieCount: number; error: string | null }> {
    const header = await readSessionCookieHeader(url);
    if (!header) return { result: null, cookieCount: 0, error: 'no session cookies' };

    const cookieCount = header.split('; ').length;
    try {
        await installCookieRule(url, header);
        const result = await send();
        return { result, cookieCount, error: null };
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { result: null, cookieCount, error: text.slice(0, 160) };
    } finally {
        await removeCookieRule();
    }
}

export const COOKIE_DOMAINS_FOR_DIAGNOSTICS = COOKIE_DOMAINS;
