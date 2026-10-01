import { test, expect, type Page } from '@playwright/test';

/**
 * A rendered PDF page must keep the page's shape.
 *
 * Each page lives in a slot (`[data-page]`) that is a flex *row* carrying a
 * `min-height` of the first page's height — the placeholder that keeps the
 * scroll geometry real before anything renders. The canvas inside it has
 * `height: auto`, and a flex item with an auto cross size is **stretched** to the
 * line by the default `align-items: stretch`. So whenever the canvas is not
 * exactly the placeholder's height — a narrower window clamps its width through
 * `max-width:100%` while the height stays the placeholder's — the page is drawn
 * stretched vertically for no reason the user can see.
 */

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', `aspect_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 30000 });
}

test.describe('a document page keeps its shape', () => {
    test('a PDF page is not stretched to its placeholder height', async ({ page }) => {
        test.setTimeout(90000);
        // Narrower than one letter page at the preview's scale, so `max-width`
        // clamps the canvas width — the case where a stretched height is visible.
        await page.setViewportSize({ width: 420, height: 800 });
        await registerAndSetup(page);

        const result = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;
            await DP._loadPdfLibForTest();
            const PDFLib = (window as any).PDFLib;
            const doc = await PDFLib.PDFDocument.create();
            doc.addPage([612, 792]); // US Letter: 612 x 792 pt
            const blob = new Blob([await doc.save()], { type: 'application/pdf' });
            DP.previewDocument(blob, 'letter.pdf', 'application/pdf');
            await new Promise((r) => setTimeout(r, 3500));

            const slot = document.querySelector('#doc-preview-content [data-page]') as HTMLElement | null;
            const canvas = slot ? slot.querySelector('canvas') as HTMLCanvasElement | null : null;
            if (!slot || !canvas) return null;
            const box = canvas.getBoundingClientRect();
            return {
                slotHeight: slot.getBoundingClientRect().height,
                width: box.width,
                height: box.height,
                naturalRatio: 792 / 612,
            };
        });

        expect(result, 'the PDF preview must have rendered a page').not.toBeNull();
        const ratio = result!.height / result!.width;
        // Portrait Letter is 1.294 tall for its width; a stretched canvas would be
        // ~3x (the placeholder is 1188px against a ~390px-wide canvas).
        expect(ratio, 'the page must keep its aspect ratio').toBeCloseTo(result!.naturalRatio, 1);
        expect(result!.height, 'the page must not fill the placeholder height').toBeLessThan(result!.slotHeight * 0.75);
    });
});
