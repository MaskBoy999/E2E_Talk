import { Page } from '@playwright/test';

/**
 * Helpers for the in-page dialogs (static/ui-dialog.js).
 *
 * Native alert/confirm/prompt popups are gone: the app renders them inside the
 * page, and under automation (navigator.webdriver) they are answered without
 * being shown so scripted flows don't stall. `page.on('dialog')` no longer fires,
 * so use these helpers instead:
 *
 *   await queuePromptAnswer(page, 'Renamed');   // answer the next uiPrompt()
 *   await queueConfirmAnswer(page, false);      // answer the next uiConfirm()
 *   expect(await dialogMessages(page)).toContain('...');   // what was shown
 */

export interface UiDialogEntry {
    type: 'alert' | 'confirm' | 'prompt';
    message: string;
    result: any;
}

/**
 * Run an in-page evaluate, tolerating the "Execution context was destroyed"
 * error that a navigation in flight causes (imports reload the admin page).
 * The dialog log survives navigations via sessionStorage, so retrying works.
 */
async function attempt<T>(run: () => Promise<T>, fallback: T): Promise<T> {
    for (let i = 0; i < 3; i++) {
        try {
            return await run();
        } catch (_) {
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
    return fallback;
}

/** Every in-page dialog recorded so far (survives navigations). */
export async function dialogLog(page: Page): Promise<UiDialogEntry[]> {
    return attempt(() => page.evaluate(() => {
        const w = window as any;
        let stored: UiDialogEntry[] = [];
        try {
            stored = JSON.parse(sessionStorage.getItem('ui_dialog_log') || '[]');
        } catch (_) { /* ignore */ }
        return (stored.length ? stored : (w.__uiDialogLog || [])) as UiDialogEntry[];
    }), []);
}

/** Messages of every in-page dialog recorded so far. */
export async function dialogMessages(page: Page): Promise<string[]> {
    return (await dialogLog(page)).map((d) => d.message);
}

/** Discard the recorded dialogs so the next assertion starts clean. */
export async function resetDialogs(page: Page): Promise<void> {
    await attempt(() => page.evaluate(() => {
        const w = window as any;
        w.__uiDialogLog = [];
        w.__uiDialogLast = null;
        try { sessionStorage.removeItem('ui_dialog_log'); } catch (_) { /* ignore */ }
    }), undefined);
}

/** Pre-seed the answers the next in-page prompt() calls return (null = cancel). */
export async function queuePromptAnswer(page: Page, ...values: (string | null)[]): Promise<void> {
    await attempt(() => page.evaluate((vals) => {
        const w = window as any;
        w.__uiDialogQueue = w.__uiDialogQueue || { confirm: [], prompt: [] };
        w.__uiDialogQueue.prompt.push(...vals);
    }, values), undefined);
}

/** Pre-seed the answers the next in-page confirm() calls return. */
export async function queueConfirmAnswer(page: Page, ...values: boolean[]): Promise<void> {
    await attempt(() => page.evaluate((vals) => {
        const w = window as any;
        w.__uiDialogQueue = w.__uiDialogQueue || { confirm: [], prompt: [] };
        w.__uiDialogQueue.confirm.push(...vals);
    }, values), undefined);
}
