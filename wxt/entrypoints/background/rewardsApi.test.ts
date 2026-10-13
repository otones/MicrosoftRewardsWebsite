// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseDailyOffers } from './rewardsApi';

describe('parseDailyOffers', () => {
  // The shape the endpoint actually returns: the day's set keyed by date.
  it('reads the set when it is keyed by date', () => {
    const payload = {
      dailySetPromotions: {
        '10/14/2026': [
          {
            offerId: 'a1',
            title: '里斯本阳光秋日魅力',
            destinationUrl: 'https://www.bing.com/search?q=lisbon&FORM=tgrew4',
            complete: false,
          },
          {
            offerId: 'a2',
            title: '迪拜凉爽沙漠理想之地',
            destinationUrl: 'https://www.bing.com/search?q=dubai&FORM=tgrew4',
            complete: true,
          },
        ],
      },
    };

    const offers = parseDailyOffers(payload);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ offerId: 'a1', complete: false });
    expect(offers[1].complete).toBe(true);
  });

  // A flat array has been seen on some accounts. Accepting both means a server-side
  // change shows up as "found the activities" rather than a silent empty day.
  it('reads the set when it is a flat array', () => {
    const payload = {
      dailySetPromotions: [
        { offerId: 'a1', destinationUrl: 'https://www.bing.com/search?q=x', complete: false },
      ],
    };
    expect(parseDailyOffers(payload)).toHaveLength(1);
  });

  // Without a destination there is nothing to visit, so such an entry must not be
  // counted as an activity that could have been completed.
  it('drops entries with no destination', () => {
    const payload = {
      dailySetPromotions: {
        '10/14/2026': [{ offerId: 'a1', title: 'no link', complete: false }],
      },
    };
    expect(parseDailyOffers(payload)).toEqual([]);
  });

  it('survives a malformed payload instead of throwing', () => {
    expect(parseDailyOffers(null)).toEqual([]);
    expect(parseDailyOffers({})).toEqual([]);
    expect(parseDailyOffers({ dailySetPromotions: 'nope' })).toEqual([]);
    expect(parseDailyOffers({ dailySetPromotions: { d: [null, 7, 'x'] } })).toEqual([]);
  });
});
