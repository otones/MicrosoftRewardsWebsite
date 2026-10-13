// Message and result shapes shared between the background scheduler and the
// rewards dashboard content script.
//
// They live here rather than in either side's module so importing one does not
// drag the other's entrypoint code (a WXT `defineContentScript` call, say) into
// the bundle it does not belong in.

// What the background asks the dashboard to do.
export interface DashboardRequest {
    action?: string;
    doDailySet?: boolean;
    doClaim?: boolean;
}

// How many daily-set cards the content script found, and how many it managed to
// click. Reported so a page that never rendered the set, or whose clicks were
// refused, is not recorded as a completed run.
export interface DailySetOutcome {
    found: number;
    clicked: number;
}

// The reply that closes the dashboard tab. Either job may be absent when it was
// switched off; a null result means that job never reported at all.
export interface DashboardDoneMessage {
    action: string;
    dailySets?: DailySetOutcome | null;
    claimed?: 'claimed' | 'nothingToClaim' | 'noCard' | 'noDialog' | null;
}
