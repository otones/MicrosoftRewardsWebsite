// @vitest-environment node
// The delivery helper only touches browser APIs, so node is enough (and avoids the
// esbuild/happy-dom clash WXT's `#imports` transform triggers).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  REWARDS_CONTENT_SCRIPT,
  deliverToContentScript,
  isFatalInjectionError,
  isPermittedUrl,
} from './deliverToContentScript';

const MESSAGE = { action: 'runDashboard' };
const OPTIONS = { timeoutMs: 4_000, retryMs: 100 };
const DASHBOARD = 'https://rewards.bing.com/dashboard';

describe('isPermittedUrl', () => {
  it('accepts the origins the manifest grants', () => {
    expect(isPermittedUrl(DASHBOARD)).toBe(true);
    expect(isPermittedUrl('https://www.bing.com/search?q=a')).toBe(true);
  });

  // A freshly created tab sits on about:blank, which no host permission covers.
  // Injecting there is refused, so it must not be counted as an attempt.
  it('rejects everything else', () => {
    expect(isPermittedUrl('about:blank')).toBe(false);
    expect(isPermittedUrl('https://example.com/')).toBe(false);
    expect(isPermittedUrl(null)).toBe(false);
    expect(isPermittedUrl(undefined)).toBe(false);
  });
});

describe('isFatalInjectionError', () => {
  // Edge's refusal on rewards.bing.com. This is the error that started the whole
  // API fallback, and it must be recognised so the caller stops waiting.
  it('recognises the refusal Edge returns for its own pages', () => {
    expect(isFatalInjectionError('The extensions gallery cannot be scripted.')).toBe(true);
  });

  it('recognises a host-permission refusal', () => {
    expect(
      isFatalInjectionError(
        'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
      )
    ).toBe(true);
  });

  // A transient failure must NOT be treated as permanent, or the run would give up
  // on a page that was merely not ready.
  it('does not treat a transient failure as permanent', () => {
    expect(isFatalInjectionError('Receiving end does not exist')).toBe(false);
    expect(isFatalInjectionError('No tab with id: 7')).toBe(false);
    expect(isFatalInjectionError(null)).toBe(false);
  });
});

// A tab's URL as `tabs.get` would report it at a given moment.
function tabAt(url: string | null) {
  return { id: 7, url } as never;
}

describe('deliverToContentScript', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it('reports acceptance when the content script answers straight away', async () => {
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript');

    const attempt = await deliverToContentScript(7, MESSAGE, OPTIONS);

    expect(attempt.accepted).toBe(true);
    expect(attempt.injected).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    // Nothing was listening, so there was no reason to inject.
    expect(inject).not.toHaveBeenCalled();
  });

  // The case this exists for: a tab that already existed when the extension was
  // loaded or reloaded never received the declared content script, so messaging it
  // fails every time. Injecting the same bundle must be what rescues the run.
  it('injects the content script and then delivers when nothing was listening', async () => {
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
    send.mockRejectedValueOnce(new Error('Receiving end does not exist'));
    send.mockResolvedValue(undefined);
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(500);
    const attempt = await promise;

    expect(attempt.accepted).toBe(true);
    expect(attempt.injected).toBe(true);
    expect(inject).toHaveBeenCalledTimes(1);
    // The bundle that ships and the bundle injected are the same file.
    expect(inject.mock.calls[0][0]).toMatchObject({
      target: { tabId: 7 },
      files: [REWARDS_CONTENT_SCRIPT],
    });
  });

  it('injects only once per URL no matter how many times it retries', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  // The regression this shape exists for. A tab created a moment ago is still on
  // about:blank, and injecting there is refused with "Extension manifest must
  // request permission to access the respective host". If that first refusal were
  // treated as the final word, the script would never be injected on the real page
  // and every daily run would fail — which is exactly what happened.
  it('still injects after the tab navigates away from about:blank', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    const get = vi.spyOn(fakeBrowser.tabs, 'get');
    // about:blank for the first few polls, then the real page.
    let calls = 0;
    get.mockImplementation(async () => {
      calls += 1;
      return tabAt(calls <= 3 ? 'about:blank' : DASHBOARD);
    });

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    // Never injected while on about:blank...
    expect(inject).toHaveBeenCalledTimes(1);
    // ...and the one injection it did make was on the permitted URL.
    expect(attempt.injectionUrl).toBe(DASHBOARD);
    expect(attempt.injected).toBe(true);
  });

  it('does not inject at all while the tab stays on about:blank', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt('about:blank'));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(inject).not.toHaveBeenCalled();
    expect(attempt.injected).toBe(false);
  });

  // A refused injection is the interesting diagnosis, so it must be reported rather
  // than swallowed: it separates "cannot inject at all" from "injected and still
  // silent".
  it('reports the injection failure when injection itself is refused', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockRejectedValue(
      new Error('Cannot access contents of the page')
    );
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(attempt.lastError).toContain('Cannot access contents of the page');
  });

  // The behaviour the API fallback depends on: a page this browser will never
  // script must be reported as such immediately, not after the full budget. Waiting
  // it out would delay the fallback by 30 seconds for no possible benefit.
  it('gives up at once when the page can never be scripted', async () => {
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    const inject = vi
      .spyOn(fakeBrowser.scripting, 'executeScript')
      .mockRejectedValue(new Error('The extensions gallery cannot be scripted.'));
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const attempt = await deliverToContentScript(7, MESSAGE, OPTIONS);

    expect(attempt.accepted).toBe(false);
    expect(attempt.unscriptable).toBe(true);
    // One delivery attempt, one injection attempt, and no retry loop.
    expect(inject).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not flag a transient failure as unscriptable', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.unscriptable).toBe(false);
  });

  // Where the tab ended up is what tells a redirect to a sign-in page apart from a
  // page that simply never answered.
  it('reports where the tab ended up', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.finalUrl).toBe(DASHBOARD);
  });

  it('survives a tab that closed underneath it', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('No tab with id: 7'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockRejectedValue(new Error('No tab with id: 7'));
    vi.spyOn(fakeBrowser.tabs, 'get').mockRejectedValue(new Error('No tab with id: 7'));

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(attempt.finalUrl).toBeNull();
  });

  // The injected path is a build-time constant, so it has to name a file the build
  // actually emits. Pinned here rather than trusted: a renamed entrypoint would
  // otherwise turn the fallback into a silent no-op.
  it('names an injected file that the build ships', async () => {
    expect(REWARDS_CONTENT_SCRIPT).toBe('content-scripts/rewards.js');
  });

  // The manifest still supports Firefox 91, which has no `scripting` API at all.
  // That must read as a clear reason, not as a type error from undefined.
  it('reports a missing scripting API instead of crashing', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue(tabAt(DASHBOARD));
    const original = (fakeBrowser as { scripting?: unknown }).scripting;
    // Simulate a browser that never had the API.
    delete (fakeBrowser as { scripting?: unknown }).scripting;
    try {
      const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
      await vi.advanceTimersByTimeAsync(10_000);
      const attempt = await promise;

      expect(attempt.accepted).toBe(false);
      expect(attempt.lastError).toContain('no scripting API');
    } finally {
      (fakeBrowser as { scripting?: unknown }).scripting = original;
    }
  });
});
