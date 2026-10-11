import './App.css';
import { useEffect, useState } from 'react';
import { useStorage } from '@/entrypoints/hooks/useStorage';
import { useSearchProgress } from '@/entrypoints/hooks/useSearchProgress';
import { useDailyRunStatus } from '@/entrypoints/hooks/useDailyRunStatus';
import { StorageValues } from '@/entrypoints/enums/storageValues';
import { DEFAULTS, LEVEL_SEARCHES } from '@/entrypoints/utils/settings';
import { clearBadge } from '@/entrypoints/utils/browserAction';
import { RECOMMENDED_MIN_TIMEOUT_SECONDS } from '@/entrypoints/utils/search';
import NumberInput from '@/entrypoints/components/NumberInput';
import AccountLevelSelect from '@/entrypoints/components/AccountLevelSelect';
import ManualClaimButton from '@/entrypoints/components/ManualClaimButton';
import SearchProgressBar from '@/entrypoints/components/SearchProgressBar';
import TimeInput from '@/entrypoints/components/TimeInput';

function App() {
    const [active, setActive] = useStorage<boolean>('active', DEFAULTS.active, StorageValues.SYNC);
    const [autoDaily, setAutoDaily] = useStorage<boolean>('autoDaily', DEFAULTS.autoDaily, StorageValues.SYNC);
    const [searches, setSearches] = useStorage<number>('searches', DEFAULTS.searches, StorageValues.SYNC);
    const [timeout, setTimeoutValue] = useStorage<number>('timeout', DEFAULTS.timeout, StorageValues.SYNC);
    const [closeTime, setCloseTime] = useStorage<number>('closeTime', DEFAULTS.closeTime, StorageValues.SYNC);
    const [accountLevel, setAccountLevel] = useStorage<string>('accountLevel', DEFAULTS.accountLevel, StorageValues.SYNC);
    const [openFirstResult, setOpenFirstResult] = useStorage<boolean>('openFirstResult', DEFAULTS.openFirstResult, StorageValues.SYNC);
    const [claimPoints, setClaimPoints] = useStorage<boolean>('claimPoints', DEFAULTS.claimPoints, StorageValues.SYNC);
    const [runAtTime, setRunAtTime] = useStorage<string>('runAtTime', DEFAULTS.runAtTime, StorageValues.SYNC);
    const [donateHover, setDonateHover] = useState(false);
    const { isLoaded, isSearching, completed, total } = useSearchProgress();
    const runStatus = useDailyRunStatus();

    // The "New" badge from an update is dismissed once the popup is opened — but
    // the badge doubles as the live search counter, so wait for the run state and
    // leave a running count alone.
    useEffect(() => {
        if (isLoaded && !isSearching) clearBadge();
    }, [isLoaded, isSearching]);

    // Only shown for a run that is in flight or already finished this session:
    // a zero count means nothing has run, and showing 0/5 would read as stalled.
    const hasRunToShow = isLoaded && (isSearching || completed > 0);

    // Gaps this short are honoured, but they are below what Microsoft reliably
    // credits — so the field warns rather than silently overriding the choice.
    const isTimeoutRisky = Number.isFinite(timeout) && timeout < RECOMMENDED_MIN_TIMEOUT_SECONDS;

    // Picking a level sets a sensible search count; the number field stays
    // editable so the user can still override it.
    function handleLevelChange(level: string): void {
        setAccountLevel(level);
        setSearches(LEVEL_SEARCHES[level] ?? DEFAULTS.searches);
    }

    return (
        <>
            <h3 className="container-fluid text-center mt-2 heading">微软积分自动奖励</h3>

            <div className="text-center">
                <ManualClaimButton isSearching={isSearching} />
                {hasRunToShow && (
                    <SearchProgressBar completed={completed} total={total} isSearching={isSearching} />
                )}
                {/* Says whether today's automatic run has happened and, when it
                    has not, that it is still coming — the failure this used to
                    leave was silence. */}
                {runStatus.isLoaded && (
                    <p className={`run-status run-status--${runStatus.view.tone}`} role="status">
                        {runStatus.view.text}
                    </p>
                )}
                <div className="checkboxes">
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="autoCheckbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
                        <label htmlFor="autoCheckbox">每日搜索</label>
                        <span className="tooltip-icon info" data-tooltip="每天首次打开浏览器时，自动打开 Bing 搜索标签页">ℹ</span>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="autoDaily" checked={autoDaily} onChange={(e) => setAutoDaily(e.target.checked)} />
                        <label htmlFor="autoDaily">每日任务</label>
                        <span className="tooltip-icon info" data-tooltip="打开 Bing 积分页，自动完成每日任务以获取额外积分">ℹ</span>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="claimPoints" checked={claimPoints} onChange={(e) => setClaimPoints(e.target.checked)} />
                        <label htmlFor="claimPoints">自动领取积分</label>
                        <span className="tooltip-icon info" data-tooltip="打开 Bing 积分页并点击「可领取」，把已获得的积分入账。标签页会短暂抢占焦点。">ℹ</span>
                    </div>
                    <div className="input-with-info">
                        <input className="form-check-input" type="checkbox" id="openFirstResult" checked={openFirstResult} onChange={(e) => setOpenFirstResult(e.target.checked)} />
                        <label htmlFor="openFirstResult">在搜索标签页中打开首个结果</label>
                        <span className="tooltip-icon info" data-tooltip="在每个搜索标签页里，随机延迟后自动打开第一个搜索结果">ℹ</span>
                    </div>
                </div>

                <div className="inputs">
                    <div className="width-100">
                        <div className="input-with-info">
                            <TimeInput id="runAtTime" label="每日运行时间" value={runAtTime} onChange={setRunAtTime} />
                            <span className="tooltip-icon info" data-tooltip="按本地时间，每天在此刻开始运行。如果那一刻浏览器没打开或电脑正在睡眠，会在之后第一次有机会时补跑。">ℹ</span>
                        </div>
                    </div>
                    <div className="width-100">
                        <div className="input-with-info">
                            <AccountLevelSelect value={accountLevel} onChange={handleLevelChange} />
                            <span className="tooltip-icon info" data-tooltip="你的积分等级决定默认搜索次数（会员 5 次、白银 10 次、黄金 20 次）">ℹ</span>
                        </div>
                    </div>
                    <div className="width-100">
                        <div className="input-with-info">
                            <NumberInput id="searches" label="搜索次数" value={searches} min={1} max={999} onChange={setSearches} />
                            <span className="tooltip-icon info" data-tooltip="要在 Bing 打开的随机标签页数量">ℹ</span>
                        </div>
                    </div>
                    <div>
                        <NumberInput id="timeout" label="搜索间隔（秒）" value={timeout} min={0} max={9999} onChange={setTimeoutValue} />
                        {isTimeoutRisky && (
                            <p className="field-warning" role="status">
                                ⚠ 低于 {RECOMMENDED_MIN_TIMEOUT_SECONDS} 秒时，微软往往不再计入搜索积分，而且浏览器也会把过短的间隔拉长。
                                {' '}建议 {DEFAULTS.timeout} 秒或以上。
                            </p>
                        )}
                    </div>
                    <div>
                        <NumberInput id="closeTime" label="关闭标签页前等待（秒）" value={closeTime} min={0} max={300} onChange={setCloseTime} />
                    </div>
                </div>
            </div>

            <div className="container-fluid text-center footer-links">
                <span>
                    <a href="https://github.com/otones/MicrosoftRewardsWebsite" className="float-start links" target="_blank">GitHub</a>
                    <img src="/imgs/github.png" alt="github-logo" />
                </span>
                <a className="links" href="https://rewards.bing.com/" target="_blank" id="rewardsLink">积分</a>
                <span className="float-end" style={{ display: 'flex', alignItems: 'center' }}>
                    <a href="https://svitspindler.com/donate" className="links" target="_blank" id="donateText" onMouseOver={() => setDonateHover(true)}>捐赠</a>
                    <img src="/imgs/justAGirlSmol.png" alt="Cat" id="donateImg" style={{ visibility: donateHover ? 'visible' : 'hidden' }} />
                </span>
            </div>
        </>
    );
}

export default App;
