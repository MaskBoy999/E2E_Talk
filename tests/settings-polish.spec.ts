import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/**
 * Settings polish + live shortcut labels (0.2.30).
 *
 * Three user-visible complaints, each pinned to something measurable rather
 * than "looks nicer":
 *
 *   1. the settings tabs were squashed together until neighbouring words
 *      touched — so the tabs now carry real gaps and never shrink below their
 *      own text (no label may overflow its button);
 *   2. rows added in the last few batches were styled inline with the
 *      browser's default widgets and read as plain — so every checkbox and
 *      field inside a settings panel now comes from one shared rule;
 *   3. the read-only shortcut list in Settings → Display kept claiming the
 *      DEFAULT keys after a remap in the Shortcuts tab — so every mention of a
 *      shortcut renders from the live binding, with no reload.
 */
test.describe('settings polish (0.2.30)', () => {
    test('the settings tabs are separated and never squash their own labels', async ({ page }) => {
        await register(page, unique('tabgap'));

        await page.evaluate(() => {
            const tabs = document.querySelectorAll('.settings-tab');
            (tabs[0] as HTMLElement).click();
            (document.getElementById('settings-modal') as HTMLElement).style.display = 'flex';
        });

        const out = await page.evaluate(() => {
            const strip = document.querySelector('.settings-tabs') as HTMLElement;
            const tabs = Array.from(document.querySelectorAll('.settings-tab')) as HTMLElement[];
            const visible = tabs.filter((t) => t.offsetParent !== null || t.getBoundingClientRect().width > 0);
            return {
                gap: parseFloat(getComputedStyle(strip).columnGap || '0'),
                nowrap: getComputedStyle(strip).overflowX === 'auto',
                labels: visible.map((t) => t.textContent || ''),
                // A squashed label is exactly this: text wider than its button.
                overflow: visible.map((t) => t.scrollWidth - t.clientWidth),
                pads: visible.map((t) => parseFloat(getComputedStyle(t).paddingLeft)),
            };
        });

        expect(out.gap, 'tabs need a real gap between them').toBeGreaterThanOrEqual(4);
        expect(out.nowrap, 'the strip scrolls instead of squashing tabs').toBe(true);
        expect(out.labels.length).toBeGreaterThan(5);
        // Every label fits inside its own button (no mid-word clipping) …
        for (const over of out.overflow) expect(over).toBeLessThanOrEqual(1);
        // … and every tab has horizontal breathing room around its word.
        for (const pad of out.pads) expect(pad).toBeGreaterThanOrEqual(8);
    });

    test('settings rows use the shared control styling, not the browser defaults', async ({ page }) => {
        await register(page, unique('rowseccss'));

        const out = await page.evaluate(() => {
            const ids = ['voice-speak-only', 'voice-hold-to-talk', 'voice-echo-cancellation', 'notif-haptic-inbox'];
            const boxes = ids.map((id) => document.getElementById(id) as HTMLInputElement).filter(Boolean);
            const first = boxes[0];
            const style = getComputedStyle(first);
            const row = first.closest('label') as HTMLElement;
            // A field that used to be an inline-styled one-off.
            const field = document.getElementById('voice-ptt-shortcut') as HTMLInputElement;
            const fstyle = getComputedStyle(field);
            return {
                count: boxes.length,
                appearance: style.appearance || (style as any).webkitAppearance,
                width: parseFloat(style.width),
                radius: style.borderRadius,
                rowDisplay: getComputedStyle(row).display,
                rowFont: parseFloat(getComputedStyle(row).fontSize),
                fieldBorder: fstyle.borderTopWidth,
                fieldRadius: fstyle.borderRadius,
                fieldBg: fstyle.backgroundColor,
                fieldFont: parseFloat(fstyle.fontSize),
                fieldMaxWidth: parseFloat(fstyle.maxWidth),
            };
        });

        expect(out.count).toBe(4);
        // The browser's own checkbox is replaced by the app's drawn one.
        expect(out.appearance).toBe('none');
        expect(out.width).toBe(18);
        expect(out.radius).not.toBe('0px');
        // The row is a proper flex row from the class, not from inline styles.
        expect(out.rowDisplay).toBe('flex');
        expect(out.rowFont).toBe(13);
        // Fields share the same panel look.
        expect(out.fieldBorder).toBe('1px');
        expect(out.fieldRadius).toBe('6px');
        expect(out.fieldFont).toBe(13);
        expect(out.fieldMaxWidth).toBeGreaterThan(100);
        // A real fill from the theme — not the transparent "unstyled" default
        // (the token it asked for used not to exist at all).
        expect(out.fieldBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(out.fieldBg).toContain('rgb');
    });

    test('remapping a shortcut updates every place it is named, live', async ({ page }) => {
        await register(page, unique('shortcutlive'));

        // Open the Display tab so its list is the one on screen.
        await page.evaluate(() => {
            const tabs = document.querySelectorAll('.settings-tab');
            for (const t of Array.from(tabs)) {
                if ((t.textContent || '').trim() === 'Display') (t as HTMLElement).click();
            }
            (document.getElementById('settings-modal') as HTMLElement).style.display = 'flex';
        });

        const before = await page.evaluate(() => {
            const list = document.getElementById('display-shortcuts-list') as HTMLElement;
            return {
                rows: list ? list.querySelectorAll('.shortcut-row').length : 0,
                text: list ? list.innerText : '',
                tooltip: (document.getElementById('search-header-btn') as HTMLElement).getAttribute('title') || '',
            };
        });
        expect(before.rows).toBeGreaterThan(3);
        expect(before.text).toContain('Toggle Streamer Mode');
        expect(before.text).toContain('Ctrl');
        expect(before.tooltip).toContain('Ctrl+Shift+K');

        // Remap the streamer-mode shortcut the way the Shortcuts tab does, and
        // then run the same repaint the tab performs.
        const after = await page.evaluate(() => {
            const w = window as any;
            const custom = { toggle_streamer_mode: { key: 'y', shift: true, ctrl: true, alt: true, label: 'Toggle Streamer Mode' } };
            localStorage.setItem('custom_shortcuts', JSON.stringify(custom));
            w.renderShortcutLabels();
            const list = document.getElementById('display-shortcuts-list') as HTMLElement;
            return { text: list.innerText, tooltip: (document.getElementById('search-header-btn') as HTMLElement).getAttribute('title') || '' };
        });

        // The read-only list follows the remap instead of claiming Ctrl+Shift+S.
        expect(after.text).toContain('Ctrl');
        expect(after.text).toContain('Alt');
        expect(after.text).toContain('Y');
        expect(after.text).not.toMatch(/Ctrl \+ Shift \+ S\b/);
        // The escaped-data shortcut (Ctrl+Shift+K) was not remapped, so its
        // tooltip still names it — the repaint did not blank the others.
        expect(after.tooltip).toContain('Ctrl+Shift+K');

        // The same repaint is what a remap inside the Shortcuts tab triggers, so
        // the tab's own list and the Display list cannot drift apart.
        const consistency = await page.evaluate(() => {
            const w = window as any;
            const fmt = w.formatShortcut(w.getShortcut('toggle_streamer_mode'));
            // The list renders the binding as <kbd> chips joined by ' + '.
            const asChips = fmt.split('+').map((p: string) => `<kbd>${p}</kbd>`).join(' + ');
            const list = document.getElementById('display-shortcuts-list') as HTMLElement;
            return { fmt, asChips, html: list.innerHTML, inList: list.innerHTML.includes(asChips) };
        });
        expect(consistency.fmt).toBe('Ctrl+Alt+Shift+Y');
        expect(consistency.inList, `list should show ${consistency.asChips}`).toBe(true);
    });

    test('the user tab no longer carries a wipe button, and the wipe paths still work', async ({ page }) => {
        await register(page, unique('nowipebtn'));

        const out = await page.evaluate(() => ({
            button: !!document.getElementById('panic-wipe-btn'),
            anyWipeLabel: Array.from(document.querySelectorAll('#user-settings button'))
                .filter((b) => /wipe everything now/i.test(b.textContent || '')).length,
            clearAll: !!document.getElementById('clear-all-data-btn'),
            chord: typeof (window as any).panicWipe,
            autoLock: !!document.getElementById('auto-lock-minutes'),
        }));

        expect(out.button).toBe(false);
        expect(out.anyWipeLabel).toBe(0);
        // The two routes the user keeps are still there: the confirmed button …
        expect(out.clearAll).toBe(true);
        expect(out.autoLock).toBe(true);
        // … and the instant chord, which is still wired.
        expect(out.chord).toBe('function');

        // The chord still wipes for real: it is the one path with no button.
        await page.evaluate(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', altKey: true, shiftKey: true, bubbles: true }));
        });
        await page.waitForURL('**/login.html**', { timeout: 20000 });
        const after = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: localStorage.getItem('user'),
        }));
        expect(after.token).toBeNull();
        expect(after.user).toBeNull();
    });
});
