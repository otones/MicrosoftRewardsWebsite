// @vitest-environment node
// The delivery helper only touches browser APIs, so node is enough (and avoids the
// esbuild/happy-dom clash WXT's `#imports` transform triggers).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { REWARDS_CONTENT_SCRIPT, deliverToContentScript } from './deliverToContentScript';

const MESSAGE = { action: 'runDashboard' };
const OPTIONS = { timeoutMs: 4_000, retryMs: 100 };

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

  it('injects only once no matter how many times it retries', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    const inject = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(inject).toHaveBeenCalledTimes(1);
  });

  // A refused injection is the interesting diagnosis, so it must be reported rather
  // than swallowed: it separates "cannot inject at all" from "injected and still
  // silent".
  it('reports the injection failure when injection itself is refused', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockRejectedValue(
      new Error('Cannot access contents of the page')
    );

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.accepted).toBe(false);
    expect(attempt.injected).toBe(true);
    expect(attempt.lastError).toContain('Cannot access contents of the page');
  });

  // Where the tab ended up is what tells a redirect to a sign-in page apart from a
  // page that simply never answered.
  it('reports where the tab ended up', async () => {
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockRejectedValue(new Error('no listener'));
    vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue([] as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockResolvedValue({
      id: 7,
      url: 'https://rewards.bing.com/dashboard',
    } as never);

    const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
    await vi.advanceTimersByTimeAsync(10_000);
    const attempt = await promise;

    expect(attempt.finalUrl).toBe('https://rewards.bing.com/dashboard');
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
    const original = (fakeBrowser as { scripting?: unknown }).scripting;
    // Simulate a browser that never had the API.
    delete (fakeBrowser as { scripting?: unknown }).scripting;
    try {
      const promise = deliverToContentScript(7, MESSAGE, OPTIONS);
      await vi.advanceTimersByTimeAsync(10_000);
      const attempt = await promise;

      expect(attempt.accepted).toBe(false);
      expect(attempt.injected).toBe(true);
      expect(attempt.lastError).toContain('no scripting API');
    } finally {
      (fakeBrowser as { scripting?: unknown }).scripting = original;
    }
  });
});
