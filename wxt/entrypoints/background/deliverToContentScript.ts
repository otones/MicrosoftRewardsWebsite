import { browser } from 'wxt/browser';

// Files WXT emits for the content scripts; the manifest's `content_scripts` block
// names these same paths. Kept here so the programmatic fallback cannot drift from
// what actually ships.
//
// WXT brands this as `ScriptPublicPath` (a known-at-build-time asset). The literal
// below is that asset, so the assertion is a statement of fact rather than an
// escape hatch — and a test pins it against the built manifest.
export const REWARDS_CONTENT_SCRIPT = 'content-scripts/rewards.js' as ScriptPublicPath;

type ScriptPublicPath = Parameters<typeof browser.scripting.executeScript>[0]['files'] extends (infer P)[] | undefined
    ? P
    : never;

// The origins the manifest declares host permissions for. Injection is only legal
// on these, and a freshly created tab is briefly on `about:blank` before it
// navigates — which is not covered by any host permission.
const PERMITTED_URL_PREFIXES = ['https://rewards.bing.com/', 'https://www.bing.com/'];

export function isPermittedUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    return PERMITTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export interface DeliveryAttempt {
    // True once a listener took the message.
    accepted: boolean;
    // True once the content script was actually injected by hand.
    injected: boolean;
    // Final URL of the tab, for diagnosing a page that never cooperated (a
    // redirect to a sign-in page being the usual reason).
    finalUrl: string | null;
    // Last error seen, so a silent failure has something to report.
    lastError: string | null;
    // Where the tab was when injection was last attempted. A refusal is almost
    // always about this URL, so it has to be recorded next to the error.
    injectionUrl: string | null;
    // True when the browser refuses to script this page at all. That is not a
    // timing problem, so retrying cannot help and the caller should take a
    // different route immediately instead of waiting out the budget.
    unscriptable: boolean;
}

// Injection refusals that no amount of retrying will change.
//
// Edge answers "The extensions gallery cannot be scripted" for some of its own
// domains (rewards.bing.com among them); Chrome Web Store and Edge Add-ons pages
// behave the same way by design. Recognising these lets the caller fall back at
// once rather than burning the whole delivery budget first.
const FATAL_INJECTION_PATTERNS = [
    'cannot be scripted',
    'cannot access contents of the page',
    'must request permission to access the respective host',
    'missing host permission',
];

export function isFatalInjectionError(message: string | null): boolean {
    if (!message) return false;
    const lower = message.toLowerCase();
    return FATAL_INJECTION_PATTERNS.some((pattern) => lower.includes(pattern));
}

// Hands the jobs to a tab's content script, injecting it if nothing answers.
//
// A statically declared content script is not guaranteed to be running: a tab that
// was already open when the extension loaded or reloaded never gets it, and a
// browser may decline to inject at all. Messaging therefore cannot be the only path.
//
// Injection is attempted only once the tab is actually on a permitted origin.
// Doing it earlier fails — a new tab is on `about:blank` for a moment, and
// `executeScript` refuses a host the manifest does not cover with "Extension
// manifest must request permission to access the respective host" — and since the
// page has not loaded yet at that point, that first refusal must not be the last
// word. Attempts are therefore latched per URL rather than once for good, so the
// script still gets injected after the navigation lands.
export async function deliverToContentScript(
    tabId: number,
    message: Record<string, unknown>,
    options: { timeoutMs: number; retryMs: number; scriptPath?: ScriptPublicPath }
): Promise<DeliveryAttempt> {
    const scriptPath = options.scriptPath ?? REWARDS_CONTENT_SCRIPT;
    const deadline = Date.now() + options.timeoutMs;
    // URLs already tried: a refusal on one origin says nothing about the next.
    const tried = new Set<string>();
    let injected = false;
    let lastError: string | null = null;
    let injectError: string | null = null;
    let injectionUrl: string | null = null;
    let unscriptable = false;

    while (Date.now() < deadline) {
        try {
            await browser.tabs.sendMessage(tabId, message);
            return {
                accepted: true,
                injected,
                finalUrl: await getTabUrl(tabId),
                lastError: null,
                injectionUrl,
                unscriptable,
            };
        } catch (error) {
            lastError = describeError(error);
        }

        // Nothing is listening. Put the script there ourselves, but only where the
        // manifest actually grants access — and only once per URL, so a genuine
        // refusal is not retried forever.
        const url = await getTabUrl(tabId);
        if (isPermittedUrl(url) && url && !tried.has(url)) {
            tried.add(url);
            injectionUrl = url;
            // Firefox only gained `scripting` in 102 and the manifest still supports
            // 91, so this can legitimately be absent. Say so plainly instead of
            // letting it surface as "cannot read properties of undefined".
            if (typeof browser.scripting?.executeScript !== 'function') {
                injectError = 'this browser has no scripting API';
            } else {
                try {
                    await browser.scripting.executeScript({
                        target: { tabId },
                        files: [scriptPath],
                    });
                    injected = true;
                    injectError = null;
                } catch (error) {
                    // Recording this is the point: it separates "injection refused"
                    // from "injected but still unanswered".
                    injectError = describeError(error);
                    // A page this browser will never script. Waiting out the rest of
                    // the budget cannot change that, and the caller has a fallback
                    // that does not need the page at all.
                    if (isFatalInjectionError(injectError)) {
                        unscriptable = true;
                        break;
                    }
                }
            }
        }

        await new Promise((resolve) => setTimeout(resolve, options.retryMs));
    }

    return {
        accepted: false,
        injected,
        finalUrl: await getTabUrl(tabId),
        lastError: injectError ?? lastError,
        injectionUrl,
        unscriptable,
    };
}

async function getTabUrl(tabId: number): Promise<string | null> {
    try {
        const tab = await browser.tabs.get(tabId);
        return tab.url ?? null;
    } catch {
        // The tab is gone; nothing to report about it.
        return null;
    }
}

function describeError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.slice(0, 200);
}
