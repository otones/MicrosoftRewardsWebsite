import { describe, it, expect } from 'vitest';
import { matchDailyAnchors } from './dailyAnchors';

function grid(inner: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `<div class="grid">${inner}</div>`;
  return root;
}

describe('matchDailyAnchors', () => {
  // The hrefs below are copied from a live dashboard. The referral card carries a
  // `form` tracking code exactly like the activities do, and it comes first in the
  // grid — matching on "has a form code" selected it and the click that followed
  // took the foreground off the dashboard, so none of the activities were
  // credited. Only the three Bing searches are daily-set cards.
  it('picks the activity cards and skips the referral card, which also has a form code', () => {
    const root = grid(`
      <a href="https://rewards.bing.com/referandearn?form=ML2X5V&amp;OCID=ML2X5V&amp;PUBL=RewardsDO&amp;CREA=ML2X5V">referandearn</a>
      <a href="https://www.bing.com/search?q=%e5%8c%97%e4%ba%ac%e4%b9%8b%e6%97%85&amp;FORM=tgrew4&amp;filters=sid%3A%221fb25c48-8192-4d17-87b6-f34f1a24bcab%22+BTEPOKey%3A%22REWARDSQUIZ_DailySet_UrlOffer%22&amp;rnoreward=1">tokyo</a>
      <a href="https://www.bing.com/search?q=%e7%8f%80%e6%96%af%e4%b9%8b%e6%97%85&amp;FORM=tgrew4&amp;filters=sid:&quot;c4f81a52&quot;&amp;rnoreward=1">perth</a>
      <a href="https://www.bing.com/search?q=%e6%8f%90%e9%ab%98%e9%98%85%e8%af%bb%e9%80%9f%e5%ba%a6&amp;form=ML2G76&amp;OCID=ML2G76&amp;PUBL=RewardsDO&amp;CREA=ML2G76&amp;rnoreward=1">reading</a>
    `);

    expect(matchDailyAnchors(root).map((a) => a.textContent)).toEqual(['tokyo', 'perth', 'reading']);
  });

  // Quizzes are daily-set activities too, and they are also Bing searches.
  it('keeps quizzes, which are Bing searches as well', () => {
    const root = grid(`
      <a href="https://www.bing.com/search?q=Berlin+quiz&amp;form=dsetqu">quiz</a>
      <a href="https://www.bing.com/search?q=Trip+to+Tokyo&amp;FORM=tgrew4">search</a>
    `);

    expect(matchDailyAnchors(root).map((a) => a.textContent)).toEqual(['quiz', 'search']);
  });

  it('skips the dashboard nav and redeem cards', () => {
    const root = grid(`
      <a href="https://rewards.bing.com/redeem">redeem</a>
      <a href="https://rewards.bing.com/redeem/sku/000434000001?">sku</a>
      <a href="/dashboard">dashboard</a>
      <a href="https://www.bing.com/">bing home</a>
      <a href="https://support.microsoft.com/topic/x">support</a>
    `);

    expect(matchDailyAnchors(root)).toEqual([]);
  });

  // A Bing search without a query credits nothing, so it is not an activity.
  it('skips a Bing search URL that carries no query', () => {
    const root = grid(`<a href="https://www.bing.com/search?form=ML2G76">no query</a>`);

    expect(matchDailyAnchors(root)).toEqual([]);
  });

  // Only the grid holds activity cards; a search link elsewhere on the page is
  // not one (the dashboard reuses search URLs in unrelated places).
  it('ignores search links outside the grid', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="grid"><a href="https://www.bing.com/search?q=inside&amp;form=x">inside</a></div>
      <div class="other"><a href="https://www.bing.com/search?q=outside&amp;form=x">outside</a></div>`;

    expect(matchDailyAnchors(root).map((a) => a.textContent)).toEqual(['inside']);
  });

  it('returns an empty array while only nav links have rendered', () => {
    const root = grid(`
      <a href="https://rewards.bing.com/redeem">x</a>
      <a href="https://www.bing.com/">y</a>
    `);

    expect(matchDailyAnchors(root)).toEqual([]);
  });

  it('ignores an href that is not a URL rather than throwing', () => {
    const root = grid(`<a href="javascript:void(0)">js</a><a href="">empty</a>`);

    expect(matchDailyAnchors(root)).toEqual([]);
  });

  // A lookalike host must not pass: only real bing.com searches are activities.
  it('rejects a lookalike host', () => {
    const root = grid(`<a href="https://bing.com.evil.example/search?q=x&amp;form=y">lookalike</a>`);

    expect(matchDailyAnchors(root)).toEqual([]);
  });
});
