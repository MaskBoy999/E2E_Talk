// Markdown is rendered for *shared files* the viewer previews, and its source
// is entirely attacker-controlled: anyone can share a .md file. inlineFormat()
// used to interpolate `$2` straight into `href="$2"` / `src="$2"` with no
// scheme check and no quote escaping, so a file containing
//
//     [click](javascript:window.__mdXssFired=true)
//     ![](x" onerror="window.__mdXssFired=true)
//
// executed script in the app's origin — the origin that holds the whole E2EE
// key chain. These tests drive the real viewer end to end and assert both that
// the dangerous element never appears and that legitimate links/images still
// render, so the fix cannot regress into "strip everything".
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
    await page.fill('#register-username', `mdxss_${ts}`);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 30000 });
    // A tripwire the payloads try to flip. It must stay false.
    await page.evaluate(() => { (window as any).__mdXssFired = false; });
}

/** Preview `body` as a markdown file and read back the live DOM. */
async function previewMarkdown(page: Page, body: string) {
    return await page.evaluate((body) => {
        (window as any).openMediaViewer(null, 'text', {
            filename: 'shared.md', mime_type: 'text/markdown', file_size: body.length, fullText: body,
        }, null);
        const el = document.querySelector('.text-viewer-content') as HTMLElement | null;
        const out = {
            present: !!el,
            html: el ? el.innerHTML : '',
            text: el ? el.textContent || '' : '',
            fired: !!(window as any).__mdXssFired,
            dangerouslySet: el ? el.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length : -1,
            anchors: el ? Array.from(el.querySelectorAll('a')).map(a => ({
                href: a.getAttribute('href') || '', rel: a.getAttribute('rel') || '',
            })) : [],
            images: el ? Array.from(el.querySelectorAll('img')).map(i => i.getAttribute('src') || '') : [],
            preLang: el && el.querySelector('.md-pre') ? (el.querySelector('.md-pre') as HTMLElement).getAttribute('data-lang') : null,
        };
        try { (window as any).closeMediaViewer(); } catch (_) {}
        return out;
    }, body);
}

test.describe('markdown preview cannot execute attacker content', () => {
    test('javascript: links are inert and never become anchors', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const shown = await previewMarkdown(page, '[click](javascript:window.__mdXssFired=true)');
        expect(shown.present).toBe(true);
        expect(shown.fired, 'the javascript: URL must not run').toBe(false);
        expect(shown.html.toLowerCase()).not.toContain('javascript:');
        expect(shown.anchors.length, 'no anchor may be created for a javascript: URL').toBe(0);
        expect(shown.text, 'the link label survives as plain text').toContain('click');
    });

    test('attribute-breakout image payloads cannot attach handlers', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const payloads = [
            '![](x" onerror="window.__mdXssFired=true)',
            '![](https://cdn.example.com/a.png" onerror="window.__mdXssFired=true)',
            '[x](https://example.com" onmouseover="window.__mdXssFired=true)',
        ];
        const shown = await previewMarkdown(page, payloads.join('\n\n'));
        expect(shown.present).toBe(true);
        expect(shown.fired, 'no attribute-breakout payload may execute').toBe(false);
        // The payload text may legitimately survive *escaped inside an attribute
        // value* (that is what makes it inert); what must not exist is a real
        // event-handler attribute on any element.
        expect(shown.dangerouslySet, 'no event-handler attribute may exist on any element').toBe(0);
    });

    test('dangerous schemes are blocked for links, data:image stays usable for images', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const body = [
            '[a](data:text/html,<script>window.__mdXssFired=true</script>)',
            '[b](vbscript:msgbox)',
            '![c](vbscript:msgbox)',
            '![d](data:text/html,<script>x</script>)',
            '![ok](data:image/png;base64,iVBORw0KGgo=)',
            '[good](https://example.com/page)',
            '[rel](/api/client-config)',
        ].join('\n\n');
        const shown = await previewMarkdown(page, body);
        expect(shown.present).toBe(true);
        expect(shown.fired).toBe(false);

        const hrefs = shown.anchors.map(a => a.href);
        expect(hrefs).toContain('https://example.com/page');
        expect(hrefs).toContain('/api/client-config');
        for (const href of hrefs) {
            expect(href.toLowerCase().startsWith('javascript:'), `blocked scheme leaked: ${href}`).toBe(false);
            expect(href.toLowerCase().startsWith('vbscript:')).toBe(false);
            expect(href.toLowerCase().startsWith('data:')).toBe(false);
        }
        const linkAnchors = shown.anchors.filter(a => a.href.startsWith('http'));
        for (const a of linkAnchors) {
            expect(a.rel, 'external links must carry rel=noopener').toContain('noopener');
        }
        expect(shown.images, 'data:image is allowed for <img>').toContain('data:image/png;base64,iVBORw0KGgo=');
        for (const src of shown.images) {
            expect(src.toLowerCase().startsWith('vbscript:'), `blocked src leaked: ${src}`).toBe(false);
            expect(src.toLowerCase().startsWith('data:text/html')).toBe(false);
        }
    });

    test('raw HTML in markdown stays text', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const shown = await previewMarkdown(page, '<img src=x onerror=window.__mdXssFired=true> <script>window.__mdXssFired=true</script>');
        expect(shown.present).toBe(true);
        expect(shown.fired).toBe(false);
        expect(shown.dangerouslySet).toBe(0);
        expect(shown.html).not.toContain('<script');
        expect(shown.html).not.toContain('<img');
        expect(shown.text).toContain('<img src=x');
    });

    test('code-fence language cannot inject attributes', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const shown = await previewMarkdown(page, '```js" onmouseover="window.__mdXssFired=true\nconst a = 1;\n```');
        expect(shown.present).toBe(true);
        expect(shown.fired).toBe(false);
        expect(shown.dangerouslySet).toBe(0);
        expect(shown.preLang, 'the raw language string survives as an attribute value only').toBe('js" onmouseover="window.__mdXssFired=true');
        // The code itself is still shown.
        expect(shown.text).toContain('const a = 1;');
    });

    test('images render as images, not as an anchor with a leading bang', async ({ page }) => {
        test.setTimeout(180000);
        await registerUser(page);

        const shown = await previewMarkdown(page, '![alt text](https://cdn.example.com/pic.png) and [a link](https://example.com)');
        expect(shown.present).toBe(true);
        expect(shown.images).toContain('https://cdn.example.com/pic.png');
        expect(shown.anchors.map(a => a.href)).toContain('https://example.com');
        expect(shown.text).not.toContain('![');
    });
});
