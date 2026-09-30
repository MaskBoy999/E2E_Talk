// What the full-screen text/code viewer actually shows.
//
// The viewer is the only way to read a source file without downloading it, and
// it renders coloured code by replacing runs of text with `<span style="...">`.
// The passes used to see the spans the *previous* pass had just written, so a
// CSS file came out reading like its own stylesheet (`color:#c586c0;` where the
// code used to be) — the text you could select no longer matched the file.
//
// The property that catches all of that at once is the round trip: the text the
// viewer shows must be the file's own text, character for character, no matter
// which language the highlighter thinks it is. Colour is checked separately
// (spans must exist and be painted a different colour from the body), because a
// viewer that shows the right text in one flat colour would also be broken.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function registerUser(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `view_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 30000 });
}

/** Open the viewer on `body` and read back what the user can see. */
async function view(page: Page, filename: string, mime: string, body: string) {
    return await page.evaluate(({ filename, mime, body }) => {
        (window as any).openMediaViewer(null, 'text', { filename, mime_type: mime, file_size: body.length, fullText: body }, null);
        const el = document.querySelector('.text-viewer-content') as HTMLElement | null;
        const out = {
            present: !!el,
            text: el ? el.textContent || '' : '',
            html: el ? el.innerHTML : '',
            spans: el ? el.querySelectorAll('span').length : 0,
            firstSpanColor: '',
            bodyColor: '',
        };
        if (el) {
            const span = el.querySelector('span') as HTMLElement | null;
            out.firstSpanColor = span ? getComputedStyle(span).color : '';
            out.bodyColor = getComputedStyle(el).color;
        }
        try { (window as any).closeMediaViewer(); } catch (_) {}
        return out;
    }, { filename, mime, body });
}

const FILES: Array<[string, string, string]> = [
    ['style.css', 'text/css', 'body {\n  color: red;\n  margin: 0;\n}\n.x { padding: 1px; /* note */ }'],
    ['app.js', 'text/javascript', 'function hello(x) {\n  return x + 1; // note\n}\nconst s = "a\\"b";'],
    ['page.html', 'text/html', '<div class="a" title="t">hi &amp; bye</div>\n<!-- c -->'],
    ['data.json', 'application/json', '{"a": 1, "b": [true, null], "c": "x"}'],
    ['conf.yaml', 'text/yaml', 'key: value\nlist:\n  - one\n  - two\nnum: 12\nflag: true\n# comment'],
    ['conf.toml', 'text/plain', '[section]\nkey = "value"\nnum = 3'],
    ['code.py', 'text/x-python', 'def f(x):\n    return x + 1  # hi'],
    ['run.sh', 'text/x-shellscript', '#!/bin/sh\necho "hi"\nif [ -f x ]; then exit 0; fi'],
    ['setup.ini', 'text/plain', '[section]\nkey=value'],
    ['plain.txt', 'text/plain', 'nothing special here'],
];

// A markdown file is the one kind the viewer deliberately does NOT echo: it is
// previewed (headings without their `#`, emphasis without its markers), which is
// a feature, not the mangling this spec exists for. What it must still do is
// show the file's own words and no leftover markup.
const MARKDOWN: [string, string, string] = ['notes.md', 'text/markdown', '# Title\n\nsome *text* and `code`'];

test.describe('the full-screen viewer shows the file, not its own markup', () => {
    test('every kind of code file reads back character for character', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        for (const [filename, mime, body] of FILES) {
            const shown = await view(page, filename, mime, body);
            expect(shown.present, `${filename}: the viewer must render a text surface`).toBe(true);
            expect(shown.text, `${filename}: the viewer must show the file's own text`).toBe(body);
            // The giveaway of the old bug was span markup rendered as text.
            expect(shown.html, `${filename}: no span markup may be visible as text`).not.toContain('&lt;span');
            expect(shown.html, `${filename}: no style declarations may be visible as text`).not.toContain('&lt;style');
        }
    });

    test('markdown is previewed, and its words survive the preview', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);
        const shown = await view(page, MARKDOWN[0], MARKDOWN[1], MARKDOWN[2]);
        expect(shown.present).toBe(true);
        expect(shown.text).toContain('Title');
        expect(shown.text).toContain('some text and code');
        expect(shown.text, 'no markdown markers may be left as text').not.toContain('*text*');
        expect(shown.html, 'no span markup may be visible as text').not.toContain('&lt;span');
    });

    test('coloured code still has colour, and stays selectable on a desktop', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const body = 'function add(a, b) {\n  // comment\n  return a + b;\n}';
        const shown = await view(page, 'snippet.js', 'text/javascript', body);
        expect(shown.text).toBe(body);
        expect(shown.spans, 'a code file must be tokenised, not shown as flat text').toBeGreaterThan(0);
        expect(shown.firstSpanColor, 'a token must be painted a different colour from the body').not.toBe(shown.bodyColor);

        // Selecting code out of the viewer is the reason it exists on desktop.
        await page.evaluate((body) => {
            (window as any).openMediaViewer(null, 'text', { filename: 'snippet.js', mime_type: 'text/javascript', file_size: body.length, fullText: body }, null);
        }, body);
        const box = await page.locator('.text-viewer-content').boundingBox();
        if (!box) throw new Error('viewer content has no box');
        const y = box.y + 12;
        await page.mouse.move(box.x + 2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });
        await page.mouse.up();
        const selected = await page.evaluate(() => (window.getSelection() || '').toString());
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        expect(selected.trim(), 'code in the viewer must be selectable on a desktop').toContain('function add');
    });
});
