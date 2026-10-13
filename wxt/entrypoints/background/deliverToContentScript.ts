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

export interface DeliveryAttempt {
    // True once a listener took the message.
    accepted: boolean;
    // True if the content script had to be injected by hand before it answered.
    injected: boolean;
    // Final URL of the tab, for diagnosing a page that never cooperated (a
    // redirect to a sign-in page being the usual reason).
    finalUrl: string | null;
    // Last error seen, so a silent failure has something to report.
    lastError: string | null;
}

// Hands the jobs to a tab's content script, injecting it if nothing answers.
//
// A statically declared content script is not guaranteed to be running: a tab that
// was already open when the extension loaded or reloaded never gets it, and a
// browser may decline to inject at all. Messaging therefore cannot be the only
// path. When nothing takes the message, the same bundle is injected by hand (its
// `oncePerPageRun` guard makes a double injection harmless) and the message is
// offered again — so the dashboard is reached either way.
export async function deliverToContentScript(
    tabId: number,
    message: Record<string, unknown>,
    options: { timeoutMs: number; retryMs: number; scriptPath?: ScriptPublicPath }
): Promise<DeliveryAttempt> {
    const scriptPath = options.scriptPath ?? REWARDS_CONTENT_SCRIPT;
    const deadline = Date.now() + options.timeoutMs;
    let injected = false;
    let lastError: string | null = null;
    let injectError: string | null = null;

    while (Date.now() < deadline) {
        try {
            await browser.tabs.sendMessage(tabId, message);
            return { accepted: true, injected, finalUrl: await getTabUrl(tabId), lastError: null };
        } catch (error) {
            lastError = describeError(error);
        }

        // Nothing is listening. Try putting the script there ourselves, once.
        if (!injected) {
            injected = true;
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
                    injectError = null;
                } catch (error) {
                    // Recording this is the point: it separates "injection refused"
                    // from "injected but still unanswered".
                    injectError = describeError(error);
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
