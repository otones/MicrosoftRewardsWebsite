// How the once-a-day automatic run reads to the user, and the storage shape
// behind it.
//
// Kept free of browser APIs so the wording — and the rule for what counts as
// "has run today" — is unit-testable. That matters more here than elsewhere:
// the whole reason this line exists is that a run which never happened used to
// leave no trace at all, so the user could only guess why.

export type RunOutcome = 'started' | 'ok' | 'failed';

export interface DailyRunState {
    // The browser's calendar day, in the same form the background stores it.
    today: string;
    // The day the last run was recorded for. Device-local: sharing it across
    // devices meant one machine's run marked the day done on every other one.
    lastOpened: string | null;
    lastRunAt: number | null;
    // As read from storage, so it may be anything; parsed below.
    lastRunOutcome: unknown;
    lastRunError: string | null;
    // The enabled daily features, in popup order. Empty means nothing can run.
    enabledFeatures: string[];
    // The local time of day the run is due at, as configured ("09:00").
    runAtTime: string | null;
}

export interface DailyRunStatusView {
    tone: 'ok' | 'warn' | 'idle' | 'running';
    text: string;
}

export function parseRunOutcome(value: unknown): RunOutcome | null {
    return value === 'started' || value === 'ok' || value === 'failed' ? value : null;
}

export function toDailyRunStatus(
    state: DailyRunState,
    formatTime: (at: number) => string
): DailyRunStatusView {
    if (state.enabledFeatures.length === 0) {
        return {
            tone: 'warn',
            text: '自动运行已关闭 —— 请勾选「每日搜索」「每日任务」或「自动领取积分」。',
        };
    }

    // A day that is not recorded yet is not a failure. The run is due at the
    // configured time and then goes at the first wake after it, so this one line
    // has to read as both "not due yet" and "due, waiting for a wake".
    if (state.lastOpened !== state.today) {
        return {
            tone: 'idle',
            text: state.runAtTime
                ? `今天的运行将在 ${state.runAtTime} 开始，之后第一次有机会时补跑。`
                : '今天还没有开始运行 —— 浏览器下次唤醒时会自动开始。',
        };
    }

    switch (parseRunOutcome(state.lastRunOutcome)) {
        case 'failed':
            return {
                tone: 'warn',
                text: `上次自动运行失败${state.lastRunError ? `：${state.lastRunError}` : ''}。`,
            };
        case 'started':
            // The day is marked but no result was recorded: the worker was torn
            // down mid-run (or the run is still going).
            return {
                tone: 'running',
                text:
                    state.lastRunAt == null
                        ? '自动运行已开始。'
                        : `自动运行已于 ${formatTime(state.lastRunAt)} 开始。`,
            };
        default:
            // No timestamp means the day was marked by a build that did not
            // record one yet.
            if (state.lastRunAt == null) {
                return { tone: 'ok', text: '今天的运行已完成。' };
            }
            return {
                tone: 'ok',
                text: state.runAtTime
                    ? `每天 ${state.runAtTime} 自动运行 —— 今天已于 ${formatTime(state.lastRunAt)} 开始。`
                    : `自动运行 —— 今天已于 ${formatTime(state.lastRunAt)} 开始。`,
            };
    }
}
