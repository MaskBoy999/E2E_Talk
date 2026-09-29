import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `pdfbig_${ts}`;
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

test.describe('Large PDFs stay bounded', () => {
    test('the preview renders only the pages near the viewport', async ({ page }) => {
        await registerAndSetup(page);

        const result = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;
            await DP._loadPdfLibForTest();
            const PDFLib = (window as any).PDFLib;
            const doc = await PDFLib.PDFDocument.create();
            for (let i = 0; i < 40; i++) {
                const p = doc.addPage([612, 792]);
                p.drawText('Page ' + (i + 1), { x: 40, y: 700, size: 20 });
            }
            const blob = new Blob([await doc.save()], { type: 'application/pdf' });
            DP.previewDocument(blob, 'large.pdf', 'application/pdf');
            await new Promise((r) => setTimeout(r, 4000));

            const overlay = document.getElementById('doc-preview-overlay');
            const content = overlay?.querySelector('#doc-preview-content') || null;
            const slots = content ? content.querySelectorAll('[data-page]') : [];
            // A page with a live backing store is what costs memory: canvas.width
            // is reset to 1 when a page scrolls far away.
            const rendered = Array.from(content ? content.querySelectorAll('canvas') : [])
                .filter((c: any) => c.width > 2 && c.height > 2).length;
            return { hasOverlay: !!overlay, slots: slots.length, rendered };
        });

        expect(result.hasOverlay).toBe(true);
        expect(result.slots).toBe(40);
        // Some page has to be on screen, but the whole document must not be.
        expect(result.rendered).toBeGreaterThan(0);
        expect(result.rendered).toBeLessThanOrEqual(6);

        await page.evaluate(() => (window as any).DocPreview.close());
        const closed = await page.evaluate(() => !document.getElementById('doc-preview-overlay'));
        expect(closed).toBe(true);
    });

    test('a page too big for a canvas is scaled down instead of refused', async ({ page }) => {
        await registerAndSetup(page);
        const s = await page.evaluate(() => {
            const DP = (window as any).DocPreview;
            const normal = DP._pdfBoundedScale(612, 792, 1.5);
            const huge = DP._pdfBoundedScale(20000, 30000, 1.5);
            return {
                normal,
                huge,
                hugePixels: (20000 * huge) * (30000 * huge),
                maxDim: Math.max(20000 * huge, 30000 * huge),
            };
        });
        // Ordinary pages are untouched; an enormous one is shrunk so its bitmap
        // stays inside the 4 MP ceiling and the 8192px dimension limit.
        expect(s.normal).toBeCloseTo(1.5, 5);
        expect(s.huge).toBeLessThan(1.5);
        expect(s.hugePixels).toBeLessThanOrEqual(4 * 1024 * 1024 + 1);
        expect(s.maxDim).toBeLessThanOrEqual(8192 + 1);
    });

    test('the editor builds one thumbnail document and caps the undo history', async ({ page }) => {
        await registerAndSetup(page);

        const result = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;
            await DP._loadPdfLibForTest();
            const PDFLib = (window as any).PDFLib;
            const doc = await PDFLib.PDFDocument.create();
            for (let i = 0; i < 40; i++) doc.addPage([612, 792]);
            const blob = new Blob([await doc.save()], { type: 'application/pdf' });

            DP.openPdfEditor(blob, 'big.pdf');
            await new Promise((r) => setTimeout(r, 3000));

            const overlay = document.getElementById('pdf-editor-overlay');
            if (!overlay) return { hasOverlay: false };
            const thumbs = overlay.querySelectorAll('#pdf-thumb-panel [data-page-idx]').length;
            const docsAfterOpen = DP._pdfThumbDocsCreated();

            // Each rotate pushes a history state carrying a full copy of the
            // bytes; fifteen of them would be 15 documents under the old
            // count-only cap.
            const rotate = Array.from(overlay.querySelectorAll('button'))
                .find((b: any) => b.title === 'Rotate Right') as any;
            for (let i = 0; i < 15; i++) {
                if (rotate && rotate.onclick) rotate.onclick();
                await new Promise((r) => setTimeout(r, 80));
            }
            await new Promise((r) => setTimeout(r, 500));

            return {
                hasOverlay: true,
                thumbs,
                docsAfterOpen,
                states: DP._pdfHistoryStates(),
                historyBytes: DP._pdfHistoryBytes(),
            };
        });

        expect(result.hasOverlay).toBe(true);
        expect(result.thumbs).toBe(40);
        // One document for the whole strip — not one per thumbnail (the bug this
        // pins: 40 pages meant 40 pdf.js documents plus 40 pdf-lib saves).
        expect(result.docsAfterOpen).toBe(1);
        expect(result.states).toBeLessThanOrEqual(12);
        expect(result.historyBytes).toBeLessThanOrEqual(24 * 1024 * 1024);

        await page.evaluate(() => {
            document.getElementById('pdf-editor-overlay')?.remove();
        });
    });
});
