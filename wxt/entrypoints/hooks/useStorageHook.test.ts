// The hook half of useStorage. Kept in a .ts file with createElement (rather than
// .tsx) because vitest only collects entrypoints/**/*.{test,spec}.ts here.
//
// What this guards is a cost, not a feature: every storage write wakes the
// background service worker, and the popup used to write all nine of its settings
// back on every open just because it had read them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getStorageItem, setStorageItem, useStorage } from './useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';

declare global {
  // React only runs effects synchronously inside act() when this is set.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

interface ProbeProps {
  storageKey: string;
  defaultValue: string;
  onRender: (value: string, setValue: (next: string) => void) => void;
}

function Probe({ storageKey, defaultValue, onRender }: ProbeProps) {
  const [value, setValue] = useStorage<string>(storageKey, defaultValue, StorageValues.SYNC);
  onRender(value, setValue);
  return null;
}

async function mount(key: string, defaultValue: string) {
  let latest = { value: defaultValue, setValue: (_next: string) => {} };
  const container = document.createElement('div');
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(Probe, {
        storageKey: key,
        defaultValue,
        onRender: (value, setValue) => {
          latest = { value, setValue };
        },
      })
    );
  });

  return {
    current: () => latest,
    async set(next: string) {
      await act(async () => {
        latest.setValue(next);
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe('useStorage hook', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.restoreAllMocks();
  });

  it('reads the stored value', async () => {
    await setStorageItem('level', 'gold', StorageValues.SYNC);

    const probe = await mount('level', 'member');

    expect(probe.current().value).toBe('gold');
    await probe.unmount();
  });

  it('falls back to the default when nothing is stored', async () => {
    const probe = await mount('level', 'member');

    expect(probe.current().value).toBe('member');
    await probe.unmount();
  });

  // Regression: reading a value back used to write it straight back out, so
  // opening the popup cost one storage write per setting — and one wake of the
  // background worker for each. The seed happens before the spy, so only the
  // hook's own writes are counted.
  it('does not write when nothing changed', async () => {
    await setStorageItem('level', 'gold', StorageValues.SYNC);
    const write = vi.spyOn(fakeBrowser.storage.sync, 'set');

    const probe = await mount('level', 'member');

    expect(probe.current().value).toBe('gold');
    expect(write).not.toHaveBeenCalled();
    await probe.unmount();
  });

  // The same, for a key that was never set: the default is used, not persisted.
  it('does not persist a default that was never stored', async () => {
    const write = vi.spyOn(fakeBrowser.storage.sync, 'set');

    const probe = await mount('level', 'member');

    expect(write).not.toHaveBeenCalled();
    expect(await getStorageItem('level', StorageValues.SYNC)).toBeNull();
    await probe.unmount();
  });

  it('writes a value the user actually changes', async () => {
    await setStorageItem('level', 'gold', StorageValues.SYNC);
    const probe = await mount('level', 'member');

    await probe.set('silver');

    expect(await getStorageItem<string>('level', StorageValues.SYNC)).toBe('silver');
    await probe.unmount();
  });

  // Setting the value must not leave a write queued behind it: the write updates
  // what storage is known to hold, so the effect settles after one write.
  it('does not write again once a changed value has settled', async () => {
    await setStorageItem('level', 'gold', StorageValues.SYNC);
    const probe = await mount('level', 'member');
    const write = vi.spyOn(fakeBrowser.storage.sync, 'set');

    await probe.set('silver');

    expect(write).toHaveBeenCalledTimes(1);
    await probe.unmount();
  });
});
