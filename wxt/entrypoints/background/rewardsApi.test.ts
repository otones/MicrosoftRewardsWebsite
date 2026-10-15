// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseDailyOffers, todayKeyFor } from './rewardsApi';

// A payload shaped like the live one: the set is keyed by date and carries several
// days at once.
function payloadWithDays(days: Record<string, unknown[]>) {
  return { dailySetPromotions: days };
}

describe('todayKeyFor', () => {
  it('formats the key the endpoint uses', () => {
    expect(todayKeyFor(new Date(2026, 9, 15))).toBe('10/15/2026');
    expect(todayKeyFor(new Date(2026, 0, 3))).toBe('1/3/2026');
  });
});

describe('parseDailyOffers', () => {
  // Measured on a live account: the payload held today's set (complete) *and*
  // tomorrow's (pending). Taking every entry would open tomorrow's activities
  // today, which credits nothing.
  it('uses only the entry for today', () => {
    const payload = payloadWithDays({
      '10/15/2026': [
        { offerId: 'today1', destinationUrl: 'https://www.bing.com/search?q=a', complete: true },
      ],
      '10/16/2026': [
        { offerId: 'tomorrow1', destinationUrl: 'https://www.bing.com/search?q=b', complete: false },
      ],
    });

    const offers = parseDailyOffers(payload, new Date(2026, 9, 15));

    expect(offers).toHaveLength(1);
    expect(offers[0].offerId).toBe('today1');
  });

  it('returns nothing when the payload has no entry for today', () => {
    const payload = payloadWithDays({
      '10/16/2026': [
        { offerId: 'tomorrow1', destinationUrl: 'https://www.bing.com/search?q=b', complete: false },
      ],
    });

    expect(parseDailyOffers(payload, new Date(2026, 9, 15))).toEqual([]);
  });

  // A lone key whose format this code cannot read is accepted: filtering is
  // impossible, so dropping the day would be the worse error.
  it('accepts a lone entry whose key is not a readable date', () => {
    const payload = payloadWithDays({
      '2026-10-15': [
        { offerId: 'x', destinationUrl: 'https://www.bing.com/search?q=a', complete: false },
      ],
    });

    expect(parseDailyOffers(payload, new Date(2026, 9, 15))).toHaveLength(1);
  });

  // ...but a lone key that IS a readable date must match today, or the next day's
  // set would be completed a day early.
  it('rejects a lone entry dated another day', () => {
    const payload = payloadWithDays({
      '10/16/2026': [
        { offerId: 'tomorrow1', destinationUrl: 'https://www.bing.com/search?q=b', complete: false },
      ],
    });

    expect(parseDailyOffers(payload, new Date(2026, 9, 15))).toEqual([]);
  });

  // Some accounts have been seen with a flat array; there is no date to filter on.
  it('reads a flat array as-is', () => {
    const payload = {
      dailySetPromotions: [{ offerId: 'a', destinationUrl: 'https://x/', complete: false }],
    };
    expect(parseDailyOffers(payload, new Date(2026, 9, 15))).toHaveLength(1);
  });

  // Without a destination there is nothing to visit, so such an entry must not be
  // counted as an activity that could have been completed.
  it('drops entries with no destination', () => {
    const payload = payloadWithDays({
      '10/15/2026': [{ offerId: 'a1', title: 'no link', complete: false }],
    });
    expect(parseDailyOffers(payload, new Date(2026, 9, 15))).toEqual([]);
  });

  it('survives a malformed payload instead of throwing', () => {
    const day = new Date(2026, 9, 15);
    expect(parseDailyOffers(null, day)).toEqual([]);
    expect(parseDailyOffers({}, day)).toEqual([]);
    expect(parseDailyOffers({ dailySetPromotions: 'nope' }, day)).toEqual([]);
    expect(
      parseDailyOffers({ dailySetPromotions: { '10/15/2026': [null, 7, 'x'] } }, day)
    ).toEqual([]);
  });
});
