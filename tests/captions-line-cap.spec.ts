// The display cap on a caption line: it keeps the NEWEST words.
//
// A 30-second window of continuous speech decodes to several hundred
// characters, and the panel holds at most `MAX_TEXT` of them. Which end gets
// trimmed is a correctness question, not cosmetics: a later decode of the same
// audio only ever contributes text past what has already been committed, so the
// words at the END of a line are the ones the reader has not seen yet. Trimming
// the front (the first implementation) silently dropped the newest words.
//
// That bug was invisible in the UI and obvious in a measurement: scoring a
// 20-second window in tests/captions-word-error.spec.ts made BOTH whisper models
// look like they lost whole sentences, because the panel had thrown the text
// away before the scorer ever saw it — 34 of 37 "errors" were truncation.
//
// So this spec pins the rule directly, through the same `pushLine` a real decode
// uses: short lines are untouched, a line over the cap starts with an ellipsis
// and ends with the newest words, and a growing live line is replaced in place
// rather than losing its tail.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

function uniq(base: string) {
    return `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

test.describe('caption line cap', () => {
    test('leaves a short line alone, and cuts a long one from the front', async ({ page }) => {
        await register(page, uniq('cap'));

        const r = await page.evaluate(() => {
            const C = (window as any).__captions;
            const max = C._maxText;
            const exact = 'x'.repeat(max);
            const over = 'x'.repeat(max) + 'y';
            const capped = C._capped(over);
            return {
                max,
                short: C._capped('a short line'),
                exactUnchanged: C._capped(exact) === exact,
                exactHasEllipsis: C._capped(exact).includes('…'),
                overLen: capped.length,
                overHead: capped[0],
                overTail: capped.slice(1),
                expectedTail: over.slice(over.length - (max - 1)),
                emptyOkay: C._capped(''),
            };
        });

        expect(r.max, 'the cap is a documented constant, not a magic number here').toBe(240);
        expect(r.short).toBe('a short line');
        // A line that exactly fits is not marked up at all.
        expect(r.exactUnchanged).toBe(true);
        expect(r.exactHasEllipsis).toBe(false);
        // One character over, and the result is still within the cap: the
        // ellipsis costs one of the 240, and nothing is added to the end.
        expect(r.overLen).toBe(r.max);
        expect(r.overHead).toBe('…');
        expect(r.overTail, 'the surviving text is the END of the original').toBe(r.expectedTail);
        expect(r.emptyOkay).toBe('');
    });

    test('a growing live line keeps its newest words and is replaced in place', async ({ page }) => {
        await register(page, uniq('caplive'));

        // ~120 numbered words is far past the cap, so the opening is guaranteed
        // to be the part that is dropped.
        const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');

        const r = await page.evaluate(({ words }: { words: string }) => {
            const C = (window as any).__captions;
            const first = `${words} FIRSTTAIL`;
            const second = `${words} FIRSTTAIL SECONDTAIL`;

            // Snapshot the text at each step: a live line is the SAME object,
            // mutated in place, so reading it later would show the later value.
            const snap = (lines: any[]) => ({ count: lines.length, text: lines[0] ? lines[0].text : '', final: !!lines[0] && lines[0].final });

            const afterFirst = snap(C._pushLine('Speaker', first, false));
            const afterSecond = snap(C._pushLine('Speaker', second, false));
            const committed = snap(C._pushLine('Speaker', second, true));
            const afterCommit = snap(C._pushLine('Speaker', second, false));

            return { max: C._maxText, afterFirst, afterSecond, committed, afterCommit };
        }, { words });

        // The tail of the FIRST line is present (not the opening).
        expect(r.afterFirst.count, 'a non-final line for one speaker is a single line').toBe(1);
        expect(r.afterFirst.text.length).toBeLessThanOrEqual(r.max);
        expect(r.afterFirst.text[0]).toBe('…');
        expect(r.afterFirst.text.endsWith('FIRSTTAIL'), 'the newest words survive the cap').toBe(true);
        expect(r.afterFirst.text.includes('word0 '), 'the opening is what scrolls off').toBe(false);

        // Growing the same live line replaces it — and the reader still ends up
        // looking at the NEWEST words, with the previous tail still in view.
        expect(r.afterSecond.count).toBe(1);
        expect(r.afterSecond.text.endsWith('SECONDTAIL')).toBe(true);
        expect(r.afterSecond.text.includes('FIRSTTAIL')).toBe(true);
        expect(r.afterSecond.text.includes('word0 ')).toBe(false);

        // Committing keeps one line; the next decode of that speaker starts a
        // new line rather than overwriting what was already read.
        expect(r.committed.count).toBe(1);
        expect(r.committed.final).toBe(true);
        expect(r.afterCommit.count).toBe(2);
    });
});
