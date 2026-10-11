// @vitest-environment node
// Storage helpers need no DOM. Running under node avoids the esbuild/jsdom
// TextEncoder invariant clash that WXT's `#imports` transform triggers in jsdom.
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  getStorageItem,
  setStorageItem,
  getStorageItems,
  setStorageItems,
} from './useStorage';

describe('useStorage helpers', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  describe('getStorageItem', () => {
    it('returns null for a key that was never set', async () => {
      expect(await getStorageItem('missing')).toBeNull();
    });

    it('round-trips a value through setStorageItem', async () => {
      await setStorageItem('counter', 3);
      expect(await getStorageItem<number>('counter')).toBe(3);
    });

    it('stores and returns arrays intact', async () => {
      const items = [{ title: 'A' }, { title: 'B' }];
      await setStorageItem('items', items);
      expect(await getStorageItem('items')).toEqual(items);
    });
  });

  describe('getStorageItems / setStorageItems', () => {
    it('writes and reads multiple keys by short name', async () => {
      await setStorageItems({ active: true, useWords: false });
      const result = await getStorageItems(['active', 'useWords']);
      expect(result).toEqual({ active: true, useWords: false });
    });

    it('returns null for keys that are unset', async () => {
      const result = await getStorageItems(['active']);
      expect(result.active).toBeNull();
    });
  });
});
