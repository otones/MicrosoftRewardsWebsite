import { useEffect, useState } from 'react';
import { storage } from '#imports';
import { getStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS } from '@/entrypoints/utils/settings';
import { toInt } from '@/entrypoints/utils/search';

export interface SearchProgressState {
    // False until the first read resolves, so the UI can avoid flashing an
    // "idle" state over a run that is actually in progress.
    isLoaded: boolean;
    isSearching: boolean;
    completed: number;
    total: number;
}

const INITIAL: SearchProgressState = {
    isLoaded: false,
    isSearching: false,
    completed: 0,
    total: DEFAULTS.searches,
};

// Live view of the background's search run. The background owns these keys, so
// this hook only reads them: once at mount, then on every storage change. Using
// storage (rather than runtime messages) means a popup opened mid-run sees the
// current count immediately and keeps ticking while it stays open. The run's
// progress is device-local while the total is a synced setting, so they are read
// from their own areas.
export function useSearchProgress(): SearchProgressState {
    const [state, setState] = useState<SearchProgressState>(INITIAL);

    useEffect(() => {
        let isMounted = true;
        void Promise.all([
            getStorageItems(['isSearching', 'currentSearch'], StorageValues.LOCAL),
            getStorageItems(['searches'], StorageValues.SYNC),
        ]).then(([run, settings]) => {
            if (!isMounted) return;
            setState({
                isLoaded: true,
                isSearching: run.isSearching ?? false,
                completed: toInt(run.currentSearch, 0),
                total: toInt(settings.searches, DEFAULTS.searches),
            });
        });

        const unwatchers = [
            storage.watch<boolean>('local:isSearching', (value) =>
                setState((prev) => ({ ...prev, isSearching: value ?? false }))
            ),
            storage.watch<number>('local:currentSearch', (value) =>
                setState((prev) => ({ ...prev, completed: toInt(value, 0) }))
            ),
            storage.watch<number>('sync:searches', (value) =>
                setState((prev) => ({ ...prev, total: toInt(value, DEFAULTS.searches) }))
            ),
        ];

        return () => {
            isMounted = false;
            unwatchers.forEach((unwatch) => unwatch());
        };
    }, []);

    return state;
}
