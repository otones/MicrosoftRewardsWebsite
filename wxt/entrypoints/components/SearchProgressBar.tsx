import { toSearchProgress } from '@/entrypoints/utils/progress';

interface SearchProgressBarProps {
    completed: number;
    total: number;
    isSearching: boolean;
}

// Shows how far today's search run has got ("3/5") plus a bar. The wording
// distinguishes a run in flight from one that finished and one the user stopped,
// so the same numbers can't be read as still-running.
function SearchProgressBar({ completed, total, isSearching }: SearchProgressBarProps) {
    const { completed: done, total: goal, percent } = toSearchProgress(completed, total);
    const isComplete = done >= goal;
    const state = isSearching ? 'running' : isComplete ? 'done' : 'idle';
    const label = isSearching ? '搜索中…' : isComplete ? '今日搜索已完成' : '搜索已停止';

    return (
        <div className="progress-card" role="status" aria-live="polite">
            <div className="progress-row">
                <span className="progress-title">
                    <span className={`progress-dot progress-dot--${state}`} aria-hidden="true" />
                    {label}
                </span>
                <span className="progress-count">
                    <strong>{done}</strong>/{goal}
                </span>
            </div>
            <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={done}
                aria-valuemin={0}
                aria-valuemax={goal}
                aria-label={`今日搜索已完成 ${done} / ${goal}`}
            >
                <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

export default SearchProgressBar;
