import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `docbig_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

/**
 * Wraps IntersectionObserver so a test can tell whether every observer a
 * renderer created was disconnected when the modal closed (the leak this suite
 * exists to prevent: an observer still holding a detached DOM subtree).
 */
const OBSERVER_SPY = `
(function () {
    var Real = window.IntersectionObserver;
    window.__ioSpy = [];
    function Spied(cb, opts) {
        var io = new Real(cb, opts);
        io.__disconnected = false;
        var realDisconnect = io.disconnect.bind(io);
        io.disconnect = function () { io.__disconnected = true; realDisconnect(); };
        window.__ioSpy.push(io);
        return io;
    }
    Spied.prototype = Real.prototype;
    window.IntersectionObserver = Spied;
})();
`;

// Installed in the page before the deck is built. renderPptxSlide lays every
// slide out at absolute pixel positions, so a one-shape slide is enough to give
// each placeholder real content once it is rendered.
const INSTALL_SLIDE_XML = `
window.__slideXml = function (n) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>' +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        '<p:grpSpPr><p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></p:xfrm></p:grpSpPr>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr>' +
        '<p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><p:xfrm>' +
        '<a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></p:xfrm></p:spPr>' +
        '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>Slide ' + n +
        '</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld';
};
`;

test.describe('Large documents stay bounded', () => {
    test('a huge spreadsheet is truncated to a bounded window, and says so', async ({ page }) => {
        await registerAndSetup(page);

        const result = await page.evaluate(async () => {
            const script = document.createElement('script');
            script.src = '/libs/xlsx.full.min.js';
            document.head.appendChild(script);
            await new Promise((r) => { script.onload = r; setTimeout(r, 3000); });
            if (!(window as any).XLSX) return { loaded: false };

            const XLSX = (window as any).XLSX;
            const rows: any[][] = [];
            for (let i = 0; i < 700; i++) rows.push(['row' + i, i, 'value ' + i]);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Big');
            const blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })],
                { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            const DP = (window as any).DocPreview;
            DP.previewDocument(blob, 'big.xlsx',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            await new Promise((r) => setTimeout(r, 4000));

            const overlay = document.getElementById('doc-preview-overlay');
            const content = overlay?.querySelector('#doc-preview-content') || null;
            return {
                loaded: true,
                hasOverlay: !!overlay,
                // The table itself now lives in the sandboxed frame; the page
                // only gets the truncation note (and the test reads the frame below).
                text: (content?.textContent || '').slice(0, 300),
            };
        });

        expect(result.loaded).toBe(true);
        expect(result.hasOverlay).toBe(true);

        // The windowed table is inside the sandboxed frame; count its rows
        // there (the app page cannot — which is the point).
        const frame = page.frameLocator('iframe.xlsx-sandbox');
        await expect(frame.locator('table')).toBeVisible();
        const tableRows = await frame.locator('table tr').count();
        expect(tableRows).toBeGreaterThanOrEqual(500);
        expect(tableRows).toBeLessThanOrEqual(502);

        expect(result.text).toContain('showing the first 500 rows');

        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('a large archive lists rows in chunks and disconnects on close', async ({ page }) => {
        await registerAndSetup(page);
        await page.evaluate(OBSERVER_SPY);

        const result = await page.evaluate(async () => {
            const script = document.createElement('script');
            script.src = '/libs/jszip.min.js';
            document.head.appendChild(script);
            await new Promise((r) => { script.onload = r; setTimeout(r, 3000); });
            if (!(window as any).JSZip) return { loaded: false };

            const zip = new (window as any).JSZip();
            for (let i = 0; i < 900; i++) zip.file('entry' + String(i).padStart(4, '0') + '.txt', 'x');
            const blob = await zip.generateAsync({ type: 'blob' });

            const DP = (window as any).DocPreview;
            DP.previewDocument(blob, 'big.zip', 'application/zip');
            await new Promise((r) => setTimeout(r, 4000));

            const list = document.querySelector('#doc-preview-content [data-zip-list]') as any;
            const more = document.querySelector('#doc-preview-content [data-zip-more]') as any;
            if (!list) return { loaded: true, hasList: false };

            // The sentinel is the last child, so it is not a row.
            const before = list.children.length - 1;
            const moreTextBefore = more?.textContent || '';

            list.scrollTop = list.scrollHeight;
            await new Promise((r) => setTimeout(r, 1500));
            const after = list.children.length - 1;

            DP.close();
            const spy = (window as any).__ioSpy as any[];
            return {
                loaded: true,
                hasList: true,
                before,
                after,
                moreTextBefore,
                observed: spy.length,
                leftConnected: spy.filter((io) => !io.__disconnected).length,
            };
        });

        expect(result.loaded).toBe(true);
        expect(result.hasList).toBe(true);
        // 900 rows, but only the first chunk exists until the sentinel is reached.
        expect(result.before).toBe(300);
        expect(result.moreTextBefore).toContain('600 more');
        expect(result.after).toBeGreaterThan(300);
        expect(result.observed).toBeGreaterThan(0);
        // Closing must release the observer, not leave it on a detached list.
        expect(result.leftConnected).toBe(0);
    });

    test('a 30-slide deck only builds the slides near the viewport', async ({ page }) => {
        await registerAndSetup(page);
        await page.evaluate(INSTALL_SLIDE_XML);
        await page.evaluate(OBSERVER_SPY);

        const result = await page.evaluate(async () => {
            const script = document.createElement('script');
            script.src = '/libs/jszip.min.js';
            document.head.appendChild(script);
            await new Promise((r) => { script.onload = r; setTimeout(r, 3000); });
            if (!(window as any).JSZip) return { loaded: false };

            const zip = new (window as any).JSZip();
            for (let i = 1; i <= 30; i++) {
                zip.file('ppt/slides/slide' + i + '.xml', (window as any).__slideXml(i));
                zip.file('ppt/slides/_rels/slide' + i + '.xml.rels',
                    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
            }
            const blob = await zip.generateAsync({ type: 'blob' });

            const DP = (window as any).DocPreview;
            DP.previewDocument(blob, 'deck.pptx',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation');
            await new Promise((r) => setTimeout(r, 5000));

            const content = document.querySelector('#doc-preview-content');
            const holders = Array.from(content ? content.querySelectorAll('.doc-view-slide') : []) as any[];
            // A holder carries a height from the start (stable scroll geometry);
            // "built" means the slide's own nodes were actually created.
            const built = holders.filter((h) => h.childElementCount > 0).length;
            const lastEmpty = holders.length ? holders[holders.length - 1].childElementCount === 0 : false;
            const spacers = holders.filter((h) => !!h.style.minHeight).length;

            DP.close();
            const spy = (window as any).__ioSpy as any[];
            return {
                loaded: true,
                holders: holders.length,
                built,
                lastEmpty,
                spacers,
                observed: spy.length,
                leftConnected: spy.filter((io) => !io.__disconnected).length,
            };
        });

        expect(result.loaded).toBe(true);
        // Every slide has a placeholder; only the first handful were built.
        expect(result.holders).toBe(30);
        expect(result.spacers).toBe(30);
        expect(result.built).toBeGreaterThan(0);
        expect(result.built).toBeLessThanOrEqual(6);
        expect(result.lastEmpty).toBe(true);
        expect(result.observed).toBeGreaterThan(0);
        expect(result.leftConnected).toBe(0);
    });
});
