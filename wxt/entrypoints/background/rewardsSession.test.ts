// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { fetchWithSession, readSessionCookieHeader } from './rewardsSession';

const URL_ = 'https://rewards.bing.com/api/getuserinfo?type=1';

describe('readSessionCookieHeader', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('joins the cookies that apply to the url', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([
      { name: '.MSA.Auth', value: 'aaa' },
      { name: 'MR', value: 'bbb' },
    ] as never);

    expect(await readSessionCookieHeader(URL_)).toBe('.MSA.Auth=aaa; MR=bbb');
  });

  // A duplicate name would send an ambiguous header; the first wins.
  it('does not repeat a cookie name', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([
      { name: 'MR', value: '1' },
      { name: 'MR', value: '2' },
    ] as never);

    expect(await readSessionCookieHeader(URL_)).toBe('MR=1');
  });

  it('reports nothing when there is no session', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([] as never);
    expect(await readSessionCookieHeader(URL_)).toBeNull();
  });
});

describe('fetchWithSession', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  // The point of the module: the cookie header has to be attached by a rule,
  // because `fetch` refuses to send a Cookie header itself.
  it('installs a rule setting the cookie header, then removes it', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([
      { name: 'MR', value: 'xyz' },
    ] as never);
    const update = vi
      .spyOn(fakeBrowser.declarativeNetRequest, 'updateSessionRules')
      .mockResolvedValue(undefined as never);

    const sent = vi.fn().mockResolvedValue('ok');
    const { result, cookieCount, error } = await fetchWithSession(URL_, sent);

    expect(result).toBe('ok');
    expect(cookieCount).toBe(1);
    expect(error).toBeNull();
    expect(update).toHaveBeenCalledTimes(2);

    const added = update.mock.calls[0][0] as {
      addRules: { action: { requestHeaders: { header: string; value: string }[] } }[];
    };
    expect(added.addRules[0].action.requestHeaders[0]).toMatchObject({
      header: 'cookie',
      value: 'MR=xyz',
    });
    // Always cleaned up, so no live credential lingers as a session rule.
    const removed = update.mock.calls[1][0] as { removeRuleIds: number[] };
    expect(removed.removeRuleIds).toHaveLength(1);
  });

  it('still removes the rule when the request fails', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([
      { name: 'MR', value: 'xyz' },
    ] as never);
    const update = vi
      .spyOn(fakeBrowser.declarativeNetRequest, 'updateSessionRules')
      .mockResolvedValue(undefined as never);

    const { result, error } = await fetchWithSession(URL_, async () => {
      throw new Error('HTTP 401');
    });

    expect(result).toBeNull();
    expect(error).toContain('401');
    expect(update).toHaveBeenCalledTimes(2);
  });

  // Without cookies there is nothing to attach, and the caller should be told that
  // rather than being handed a 401 it cannot explain.
  it('does not send when there are no cookies', async () => {
    vi.spyOn(fakeBrowser.cookies, 'getAll').mockResolvedValue([] as never);
    const send = vi.fn();

    const { result, error } = await fetchWithSession(URL_, send);

    expect(send).not.toHaveBeenCalled();
    expect(result).toBeNull();
    expect(error).toBe('no session cookies');
  });
});
