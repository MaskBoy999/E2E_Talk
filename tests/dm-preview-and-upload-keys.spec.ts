import { test, expect, type Page } from '@playwright/test';

/**
 * Two reported bugs, pinned against the real page:
 *
 *  1. The DM list's one-line preview printed raw JSON. A plain message travels as
 *     `{"type":"text","text":"…"}`, and the preview only knew the `file` /
 *     `files` shapes — everything else fell through to `decrypted.substring(0,
 *     40)`, so the sidebar read `{"type":"text","text":"@test"}`.
 *
 *  2. The upload dialog answered neither key. Enter did nothing (the flow needed
 *     a reach for the mouse) and Escape hid the panel without running Cancel, so
 *     the list and a running transfer survived the close.
 */

const BASE = 'https://localhost:3443';

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 30000 });
}

test.describe('the page-alive beacon the shell watches', () => {
    test('the overlay reports itself only inside the shell', async ({ page }) => {
        // The shell cannot see a window showing the WebView's *own* error page
        // (that page runs no script), so the overlay is its only witness. It has
        // to announce the moment it boots — otherwise the shell would have to
        // wait for the first interval before knowing the page is real.
        await page.addInitScript(() => {
            (window as any).__emits = [];
            (window as any).__TAURI__ = {
                core: { invoke: async () => null },
                event: { emit: async (name: string) => { (window as any).__emits.push(name); } },
            };
        });
        await page.goto(`${BASE}/login.html`);
        await expect.poll(() => page.evaluate(() => (window as any).__emits), { timeout: 20000 })
            .toContain('box:page-alive');

        // In a plain browser there is no shell to tell, and nothing to tell it.
        const plain = await page.context().newPage();
        await plain.addInitScript(() => {
            (window as any).__emits = [];
            delete (window as any).__TAURI__;
        });
        await plain.goto(`${BASE}/login.html`);
        await plain.waitForSelector('#show-register', { timeout: 20000 });
        await plain.waitForTimeout(500);
        expect(await plain.evaluate(() => (window as any).__emits)).toEqual([]);
        await plain.close();
    });
});

test.describe('the DM list preview and the upload dialog keys', () => {
    test('a DM preview shows the message, never the JSON it travels in', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const alice = `pv_a_${ts}`;
        const bob = `pv_b_${ts}`;

        await register(page, alice);
        const aliceToken = await page.evaluate(() => localStorage.getItem('token'));

        const ctx2 = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        await register(page2, bob);
        const bobToken = await page2.evaluate(() => localStorage.getItem('token'));

        // Friends first: the DM channel is created by accepting the request.
        const bobCode = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
            data: { friend_code: bobCode },
        });
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${bobToken}` },
        })).json();
        await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });

        const bobUser = await (await page.request.get(`${BASE}/api/user/${bob}`, {
            headers: { Authorization: `Bearer ${aliceToken}` },
        })).json();
        const dm = await (await page.request.post(`${BASE}/api/dm/${bobUser.id}`, {
            headers: { Authorization: `Bearer ${aliceToken}` },
        })).json();

        // Alice sends one ordinary message — the payload that used to be printed
        // verbatim — through the app's own crypto and socket.
        await page.goto(`${BASE}/index.html`);
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1000);
        const sent = await page.evaluate(async ({ dmChannelId, userId2, name }) => {
            for (let i = 0; i < 100; i++) {
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            await selectDmChannel(dmChannelId, userId2, name, null);
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + userId2, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const other = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const enc = E2ECrypto.encryptDm('Hello from the preview test', dmChannelId, kp.privateKey, other);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: enc.ciphertext,
                nonce: enc.nonce,
                message_nonce: enc.messageNonce || null,
            }));
            return 'SENT';
        }, { dmChannelId: dm.id, userId2: bobUser.id, name: bob });
        expect(sent).toBe('SENT');

        // Wait until the server has it, then load Bob's fresh DM list.
        await expect.poll(async () => {
            const msgs = await (await page.request.get(`${BASE}/api/dm/${dm.id}/messages`, {
                headers: { Authorization: `Bearer ${aliceToken}` },
            })).json();
            return Array.isArray(msgs) ? msgs.length : 0;
        }, { timeout: 30000 }).toBeGreaterThanOrEqual(1);

        await page2.goto(`${BASE}/index.html`);
        await page2.click('#dm-strip-btn');
        await page2.waitForSelector('.dm-item .dm-preview', { timeout: 20000 });
        const preview = await page2.locator('.dm-item .dm-preview').first().textContent();

        expect(preview, 'the preview is the message').toContain('Hello from the preview test');
        expect(preview, 'never the wire format').not.toContain('"type"');
        expect(preview, 'never the wire format').not.toContain('{');

        await page2.close();
        await ctx2.close();
    });

    test('Escape cancels the upload dialog, and Enter starts it', async ({ page }) => {
        test.setTimeout(90000);
        const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await register(page, `uk_${ts}`);

        // Escape is the Cancel button, not merely "hide the panel": the picked
        // files have to go with it.
        await page.evaluate(() => {
            selectedFiles = [new File(['hello'], 'note.txt', { type: 'text/plain' })];
            currentFileIndex = 0;
            showUploadModal();
        });
        await expect(page.locator('#upload-modal')).toBeVisible();
        await expect(page.locator('#upload-file-info')).toContainText('note.txt');

        await page.keyboard.press('Escape');
        await expect(page.locator('#upload-modal')).toBeHidden();
        expect(await page.evaluate(() => selectedFiles.length)).toBe(0);
        expect(await page.evaluate(() => isUploading)).toBe(false);

        // Enter is the Upload button. `startFileUpload` is a top-level binding in
        // a classic script, so the dialog's own handler resolves it through the
        // global object — swapping it there observes the key without uploading.
        await page.evaluate(() => {
            (window as any).__entered = 0;
            (window as any).startFileUpload = () => { (window as any).__entered++; };
            selectedFiles = [new File(['hello'], 'note.txt', { type: 'text/plain' })];
            currentFileIndex = 0;
            showUploadModal();
        });
        await expect(page.locator('#upload-modal')).toBeVisible();
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => (window as any).__entered)).toBe(1);

        // And the modal is gone from the list before the next test's Enter — the
        // key must not fire when no upload dialog is open.
        await page.evaluate(() => _closeUploadModalNow());
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => (window as any).__entered)).toBe(1);
    });
});
