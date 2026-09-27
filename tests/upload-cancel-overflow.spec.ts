import { test, expect, type Page } from '@playwright/test';

/**
 * Two attachment bugs the release fixes, pinned here against the real page:
 *
 *  1. A long file name / mime type used to widen the whole message list and give
 *     the chat a horizontal scrollbar. `word-break: break-word` alone is not
 *     enough — the card is a flex item, so it still grew to its content width and
 *     pushed the list sideways.
 *
 *  2. Cancel on the upload dialog used to be cosmetic: it flipped a flag the
 *     chunk loop checked, so the in-flight request still completed and the file
 *     record and every chunk already written stayed on the server with nothing
 *     referencing them. Cancel must abort the transfer AND delete what reached
 *     the server.
 *
 * Both drive the page's own code (buildFileCardHtml, uploadFileToServer,
 * cancelUpload) rather than a copy of it.
 */

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', `up_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

test.describe('attachment cards and upload cancel', () => {
    test('a long file name and mime type never widen the message list', async ({ page }) => {
        // The card is capped at min(420px, 85vw); a phone-width viewport is where
        // an unbreakable file name or mime type actually pushes the list sideways.
        await page.setViewportSize({ width: 380, height: 720 });
        await registerAndSetup(page);

        // The real card, built by the app's own renderer, inside the real
        // message structure (avatar + content + header).
        await page.evaluate(() => {
            const longName = 'P'.repeat(300) + '.docx';
            const longMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            const card = buildFileCardHtml({
                file_id: 'test-file-id',
                file_key: 'test-key',
                filename: longName,
                mime_type: longMime,
                file_size: 123456,
            });
            const list = document.getElementById('message-list') as HTMLElement;
            const msg = document.createElement('div');
            msg.className = 'message';
            msg.id = 'overflow-probe';
            msg.innerHTML =
                '<div class="avatar">T</div>' +
                '<div class="content">' +
                    '<div class="header"><span class="display-name">Tester</span></div>' +
                    card +
                '</div>';
            list.appendChild(msg);
        });

        // Let layout settle.
        await page.waitForTimeout(100);

        const metrics = await page.evaluate(() => {
            const list = document.getElementById('message-list') as HTMLElement;
            const card = document.querySelector('#overflow-probe .file-card') as HTMLElement;
            const name = document.querySelector('#overflow-probe .file-name') as HTMLElement;
            return {
                listScroll: list.scrollWidth,
                listClient: list.clientWidth,
                cardRight: card.getBoundingClientRect().right,
                listRight: list.getBoundingClientRect().right,
                docScroll: document.documentElement.scrollWidth,
                viewport: window.innerWidth,
                wrap: getComputedStyle(name).overflowWrap,
            };
        });

        expect(metrics.listScroll, 'the message list must not scroll sideways').toBeLessThanOrEqual(metrics.listClient + 1);
        expect(metrics.cardRight, 'the card must stay inside the list').toBeLessThanOrEqual(metrics.listRight + 1);
        expect(metrics.docScroll, 'the page must not gain a horizontal scrollbar').toBeLessThanOrEqual(metrics.viewport + 1);
        expect(metrics.wrap, '.file-name must break long tokens anywhere').toBe('anywhere');
    });

    test('Cancel aborts the transfer and deletes the partial upload', async ({ page }) => {
        await registerAndSetup(page);

        const result = await page.evaluate(async () => {
            // Stand up the same controller startFileUpload creates, then run the
            // real uploader and cancel it mid-transfer. These are chat.js's own
            // top-level `let` bindings, so they are referenced bare.
            _uploadAbortController = new AbortController();
            _uploadCancelled = false;
            _uploadBatchFileIds = [];

            const bytes = new Uint8Array(8 * 1024 * 1024);
            crypto.getRandomValues(bytes.subarray(0, 65536));
            const file = new File([bytes], 'cancel-me.bin', { type: 'application/octet-stream' });

            let outcome = 'pending';
            const uploaded = uploadFileToServer(file).then(
                () => { outcome = 'resolved'; },
                (e: any) => { outcome = 'rejected:' + (e && (e.name || e.message)); },
            );

            // Wait until the server has accepted the record (this is the moment a
            // cosmetic cancel used to leave garbage behind).
            const deadline = Date.now() + 10000;
            while (!_uploadInFlightFileId && outcome === 'pending' && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 20));
            }
            const fileId = _uploadInFlightFileId;

            cancelUpload();
            await uploaded;

            // The purge is fire-and-forget: poll until the server says it is gone.
            let gone = false;
            for (let i = 0; i < 50 && fileId; i++) {
                const res = await authFetch('/api/files/' + encodeURIComponent(fileId) + '/download');
                if (res.status === 404) { gone = true; break; }
                await new Promise((r) => setTimeout(r, 100));
            }

            return { outcome, fileId, gone };
        });

        expect(result.fileId, 'the upload must have reached the server before the cancel').toBeTruthy();
        expect(result.outcome, 'cancel must reject the upload instead of resolving it').toContain('rejected');
        expect(result.gone, 'the partial upload must be deleted from the server').toBe(true);
    });
});
