import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import {
    checkLastOpened,
    handleDailyCheckAlarm,
    handleInstallOrUpdate,
    handleStartup,
    isDailyCheckAlarm,
    runRewards,
    scheduleDailyCheckAlarm,
    watchDailyFeatureToggles,
} from './background/dailySchedule';
import { handleAlarmStep, stopSearches, watchSearchesToggle } from './background/searchRunner';
import { isCleanupAlarm, sweepStaleTabs } from './background/tabCleanup';

export default defineBackground(() => {
    browser.runtime.onInstalled.addListener(handleInstallOrUpdate);
    browser.runtime.onStartup.addListener(handleStartup);
    watchSearchesToggle();
    watchDailyFeatureToggles();
    // Covers a fresh install and any other worker wake-up that isn't a full
    // browser restart, so the daily-check alarm doesn't wait on onStartup.
    void scheduleDailyCheckAlarm();
    // Every worker wake is also a chance to notice that today has not run yet.
    // This is the trigger the other two cannot cover: a browser that is never
    // fully restarted (onStartup never fires) and an alarm that a restart cleared
    // or the device sleeping delayed. The gate is date-based and idempotent, so
    // the extra calls cost a couple of storage reads and do nothing on a day
    // that has already run.
    void checkLastOpened();
    browser.runtime.onMessage.addListener((request: { action?: string }) => {
        if (request.action === 'popup') void runRewards();
        else if (request.action === 'stop') void stopSearches();
    });
    // Registered here, at the worker's top level, so the browser wakes a
    // torn-down service worker for it — the only kind of timer that survives.
    browser.alarms.onAlarm.addListener((alarm) => {
        if (isCleanupAlarm(alarm.name)) void sweepStaleTabs();
        else if (isDailyCheckAlarm(alarm.name)) void handleDailyCheckAlarm(alarm);
        else void handleAlarmStep(alarm);
    });
});
