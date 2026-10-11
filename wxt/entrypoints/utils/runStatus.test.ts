// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseRunOutcome, toDailyRunStatus, type DailyRunState } from './runStatus';

const TODAY = '2026/10/11';
const YESTERDAY = '2026/10/10';

// Deterministic stand-in for toLocaleTimeString, so the assertions do not depend
// on the machine's clock format.
const formatTime = (at: number) => `at:${at}`;

function state(overrides: Partial<DailyRunState> = {}): DailyRunState {
  return {
    today: TODAY,
    lastOpened: TODAY,
    lastRunAt: null,
    lastRunOutcome: 'ok',
    lastRunError: null,
    enabledFeatures: ['每日搜索'],
    runAtTime: '09:00',
    ...overrides,
  };
}

describe('parseRunOutcome', () => {
  it('accepts the three outcomes the background records', () => {
    expect(parseRunOutcome('started')).toBe('started');
    expect(parseRunOutcome('ok')).toBe('ok');
    expect(parseRunOutcome('failed')).toBe('failed');
  });

  it('rejects anything else, including values from a newer build', () => {
    expect(parseRunOutcome(undefined)).toBeNull();
    expect(parseRunOutcome(null)).toBeNull();
    expect(parseRunOutcome('OK')).toBeNull();
    expect(parseRunOutcome(42)).toBeNull();
    expect(parseRunOutcome({ outcome: 'ok' })).toBeNull();
  });
});

describe('toDailyRunStatus', () => {
  // The most common reason nothing runs at all, so it is worth naming the
  // switches rather than reporting a healthy-looking status.
  it('warns when no daily feature is enabled', () => {
    const view = toDailyRunStatus(state({ enabledFeatures: [] }), formatTime);

    expect(view.tone).toBe('warn');
    expect(view.text).toContain('自动运行已关闭');
    expect(view.text).toContain('每日搜索');
  });

  // The failure this status line exists to end: a day that had not run yet used
  // to look exactly like a day that had.
  it('reports a day that has not run yet as still coming, not as a failure', () => {
    const view = toDailyRunStatus(state({ lastOpened: YESTERDAY }), formatTime);

    expect(view.tone).toBe('idle');
    expect(view.text).toContain('今天的运行将在 09:00 开始');
  });

  // The configured time is the answer to "when will it run?", so the pending line
  // names it rather than leaving the user to guess.
  it('names the configured time while today is still pending', () => {
    const view = toDailyRunStatus(state({ lastOpened: YESTERDAY, runAtTime: '18:30' }), formatTime);

    expect(view.tone).toBe('idle');
    expect(view.text).toContain('18:30');
  });

  it('falls back to a time-free line when no time is configured', () => {
    const view = toDailyRunStatus(state({ lastOpened: YESTERDAY, runAtTime: null }), formatTime);

    expect(view.tone).toBe('idle');
    expect(view.text).toContain('今天还没有开始运行');
  });

  it("does not report yesterday's failure as today's", () => {
    const view = toDailyRunStatus(
      state({ lastOpened: YESTERDAY, lastRunOutcome: 'failed', lastRunError: 'no window' }),
      formatTime
    );

    expect(view.tone).toBe('idle');
    expect(view.text).not.toContain('no window');
  });

  it('reports a finished run with the daily time and the time it started', () => {
    const view = toDailyRunStatus(state({ lastRunAt: 42 }), formatTime);

    expect(view).toEqual({
      tone: 'ok',
      text: '每天 09:00 自动运行 —— 今天已于 at:42 开始。',
    });
  });

  it('drops the daily time from a finished run when none is configured', () => {
    const view = toDailyRunStatus(state({ lastRunAt: 42, runAtTime: null }), formatTime);

    expect(view).toEqual({
      tone: 'ok',
      text: '自动运行 —— 今天已于 at:42 开始。',
    });
  });

  // A day marked by a build that did not record a start time yet.
  it('falls back to a plain done message when no start time was recorded', () => {
    const view = toDailyRunStatus(state({ lastRunAt: null }), formatTime);

    expect(view.tone).toBe('ok');
    expect(view.text).toBe('今天的运行已完成。');
  });

  // The day is marked but no result was written: the worker was torn down
  // mid-run, or the run is still going.
  it('reports a run that started but never recorded a result', () => {
    const view = toDailyRunStatus(state({ lastRunAt: 42, lastRunOutcome: 'started' }), formatTime);

    expect(view.tone).toBe('running');
    expect(view.text).toContain('at:42');
  });

  it('surfaces the recorded error for a failed run', () => {
    const view = toDailyRunStatus(
      state({ lastRunAt: 42, lastRunOutcome: 'failed', lastRunError: 'no window' }),
      formatTime
    );

    expect(view.tone).toBe('warn');
    expect(view.text).toBe('上次自动运行失败：no window。');
  });

  it('still reports a failure that recorded no message', () => {
    const view = toDailyRunStatus(state({ lastRunOutcome: 'failed' }), formatTime);

    expect(view.tone).toBe('warn');
    expect(view.text).toBe('上次自动运行失败。');
  });

  it('treats an unrecognized stored outcome as a finished run', () => {
    const view = toDailyRunStatus(state({ lastRunOutcome: 'somethingElse' }), formatTime);

    expect(view.tone).toBe('ok');
  });
});
