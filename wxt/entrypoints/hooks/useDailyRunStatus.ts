import { useEffect, useState } from 'react';
import { storage } from '#imports';
import { getStorageItems } from '@/entrypoints/hooks/useStorage';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS } from '@/entrypoints/utils/settings';
import { DailyRunStatusView, toDailyRunStatus } from '@/entrypoints/utils/runStatus';

interface RawState {
    lastOpened: string | null;
    lastRunAt: number | null;
    lastRunOutcome: unknown;
    lastRunError: string | null;
    lastRunNote: string | null;
    // null until read (storage.watch reports a missing key as null), so the
    // defaults below are what the background would also use.
    active: boolean | null;
    autoDaily: boolean | null;
    claimPoints: boolean | null;
    runAtTime: string | null;
}

const EMPTY: RawState = {
    lastOpened: null,
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunError: null,
    lastRunNote: null,
    active: null,
    autoDaily: null,
    claimPoints: null,
    runAtTime: null,
};

// Mirrors useSearchProgress: read once on mount, then follow storage. The
// background owns every key read here, so this hook only reads — which also
// means the popup can report on yesterday's run without starting one.
export function useDailyRunStatus(): { isLoaded: boolean; view: DailyRunStatusView } {
    const [state, setState] = useState<RawState>(EMPTY);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        let isMounted = true;
        void Promise.all([
            getStorageItems(['lastOpened', 'lastRunAt', 'lastRunOutcome', 'lastRunError', 'lastRunNote'], StorageValues.LOCAL),
            getStorageItems(['active', 'autoDaily', 'claimPoints', 'runAtTime'], StorageValues.SYNC),
        ]).then(([run, toggles]) => {
            if (!isMounted) return;
            setState({ ...EMPTY, ...run, ...toggles });
            setIsLoaded(true);
        });

        function patch(values: Partial<RawState>): void {
            setState((prev) => ({ ...prev, ...values }));
        }

        const unwatchers = [
            storage.watch<string>('local:lastOpened', (value) => patch({ lastOpened: value })),
            storage.watch<number>('local:lastRunAt', (value) => patch({ lastRunAt: value })),
            storage.watch<unknown>('local:lastRunOutcome', (value) => patch({ lastRunOutcome: value })),
            storage.watch<string>('local:lastRunError', (value) => patch({ lastRunError: value })),
            storage.watch<string>('local:lastRunNote', (value) => patch({ lastRunNote: value })),
            storage.watch<boolean>('sync:active', (value) => patch({ active: value })),
            storage.watch<boolean>('sync:autoDaily', (value) => patch({ autoDaily: value })),
            storage.watch<boolean>('sync:claimPoints', (value) => patch({ claimPoints: value })),
            storage.watch<string>('sync:runAtTime', (value) => patch({ runAtTime: value })),
        ];

        return () => {
            isMounted = false;
            unwatchers.forEach((unwatch) => unwatch());
        };
    }, []);

    // Same defaults the background falls back to, so the popup cannot claim the
    // run is configured when the background would treat it as off (or the reverse).
    const enabledFeatures = [
        (state.active ?? DEFAULTS.active) ? '每日搜索' : null,
        (state.autoDaily ?? DEFAULTS.autoDaily) ? '每日任务' : null,
        (state.claimPoints ?? DEFAULTS.claimPoints) ? '自动领取积分' : null,
    ].filter((label): label is string => label !== null);

    const view = toDailyRunStatus(
        {
            today: new Date().toLocaleDateString(),
            lastOpened: state.lastOpened,
            lastRunAt: state.lastRunAt,
            lastRunOutcome: state.lastRunOutcome,
            lastRunError: state.lastRunError,
            lastRunNote: state.lastRunNote,
            enabledFeatures,
            runAtTime: state.runAtTime ?? DEFAULTS.runAtTime,
        },
        (at) => new Date(at).toLocaleTimeString()
    );

    return { isLoaded, view };
}
