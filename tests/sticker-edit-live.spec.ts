import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

function createTestImageBuffer(size: number): Buffer {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let buf = Buffer.from(base64, 'base64');
    while (buf.length < size) buf = Buffer.concat([buf, buf]);
    return buf;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerAndKey(page: any, token: string, userId: string) {
    const inviteCode = generateCode(8);
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { invite_code: inviteCode },
    });
    const server = await srv.json();
    await page.evaluate(async ({ serverId, userId }: { serverId: string; userId: string }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId });
    const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const channels = await chRes.json();
    return { serverId: server.id, channelId: channels[0].id, inviteCode };
}

async function openChannel(page: any) {
    await page.evaluate(async () => { await loadServers(); });
    await page.waitForTimeout(2000);
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(2000);
    await page.locator('#message-input').waitFor({ state: 'visible', timeout: 15000 });
}

test.describe('Sticker + live edit regressions', () => {
    test('editing a server-channel sticker message keeps the sticker renderable (nonce preserved)', async ({ page }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const body = await registerUser(page, 'regstk_' + ts);
        await createServerAndKey(page, body.token, body.user.id);
        await openChannel(page);

        // Upload a sticker and send it WITH text (so the message has an editable .text element).
        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(500);
        const uploadTab = page.locator('.sticker-tab[data-tab="upload"]');
        if (await uploadTab.isVisible()) await uploadTab.click();
        await page.waitForTimeout(500);
        const chooser = page.waitForEvent('filechooser');
        await page.click('#sticker-upload-trigger');
        const fc = await chooser;
        await fc.setFiles([{ name: 'reg.png', mimeType: 'image/png', buffer: createTestImageBuffer(100) }]);
        await page.waitForTimeout(1500);
        await page.fill('#sticker-upload-name', 'regstk_' + ts);
        const confirmBtn = page.locator('#confirm-sticker-upload');
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) await confirmBtn.click();
        await page.waitForTimeout(10000);

        await page.click('#sticker-btn');
        await page.waitForSelector('#sticker-panel', { state: 'visible' });
        await page.waitForTimeout(500);
        const stickerTab = page.locator('.sticker-tab[data-tab="stickers"]');
        if (await stickerTab.isVisible()) await stickerTab.click();
        await page.waitForTimeout(2500);
        await page.locator('#message-input').fill('sticker caption ' + ts);
        const firstSticker = page.locator('.sticker-grid-item').first();
        await firstSticker.waitFor({ state: 'visible', timeout: 8000 });
        await firstSticker.click();
        await page.waitForTimeout(5000);

        // Sticker rendered before edit.
        const before = await page.evaluate(() => {
            const s = document.querySelector('.sticker-message');
            return s ? { hasImg: !!s.querySelector('img'), unavailable: (s.textContent || '').indexOf('sticker unavailable') !== -1 } : null;
        });
        expect(before).not.toBeNull();
        expect(before!.hasImg).toBe(true);
        expect(before!.unavailable).toBe(false);

        // Edit the message (change the caption).
        await page.hover('.message >> nth=0');
        await page.waitForSelector('[data-action="edit"]', { timeout: 5000 });
        await page.click('[data-action="edit"]');
        await page.waitForSelector('.edit-textarea', { timeout: 5000 });
        await page.fill('.edit-textarea', 'edited caption ' + ts);
        await page.click('.edit-save-btn');
        await page.waitForTimeout(4000);

        // Sticker must still render after the edit (regression: it used to become
        // "[sticker unavailable]" because file_key_nonce was dropped from the edit payload).
        const after = await page.evaluate(() => {
            const s = document.querySelector('.sticker-message');
            return s ? { hasImg: !!s.querySelector('img'), unavailable: (s.textContent || '').indexOf('sticker unavailable') !== -1 } : null;
        });
        expect(after).not.toBeNull();
        expect(after!.hasImg).toBe(true);
        expect(after!.unavailable).toBe(false);

        // Caption text updated live.
        const texts = await page.locator('.message .text').allTextContents();
        expect(texts.some(t => t && t.includes('edited caption ' + ts))).toBeTruthy();
    });

    test('DM edit propagates live to the other user (raw sender UUID used for identity)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, 'regdm_b_' + ts);
        const body1 = await registerUser(page, 'regdm_a_' + ts);

        // Become friends.
        const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
        const fr = await page.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
            data: { friend_code: fc2 },
        });
        expect(fr.ok()).toBeTruthy();
        const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body2.token}` },
        })).json();
        const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acc.ok()).toBeTruthy();
        await page.waitForTimeout(2000);

        const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        const dmChannel = await dm.json();
        const dmChannelId = dmChannel.id;

        // Both open the DM.
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn', { timeout: 15000 });
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.evaluate(async ({ dmChannelId, userId2 }: { dmChannelId: string; userId2: string }) => {
            for (let i = 0; i < 50; i++) { if (ws && ws.readyState === WebSocket.OPEN) break; await new Promise(r => setTimeout(r, 100)); }
            await selectDmChannel(dmChannelId, userId2, null, null);
        }, { dmChannelId, userId2: userData.id });
        await page.waitForTimeout(1000);

        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('#dm-strip-btn', { timeout: 15000 });
        await page2.click('#dm-strip-btn');
        await page2.waitForTimeout(1500);
        await page2.click('.dm-item');
        await page2.waitForTimeout(2000);

        // A sends a DM message.
        await page.evaluate(async ({ dmChannelId, msg }: { dmChannelId: string; msg: string }) => {
            for (let i = 0; i < 50; i++) { if (ws && ws.readyState === WebSocket.OPEN) break; await new Promise(r => setTimeout(r, 100)); }
            const kp = E2ECrypto.getIdentityKeyPair();
            const res = await fetch('/api/identity/' + currentDmOtherUser.id, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const data = await res.json();
            const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({ type: 'dm_send', dm_channel_id: dmChannelId, encrypted_content: encrypted.ciphertext, nonce: encrypted.nonce, message_nonce: encrypted.messageNonce || null }));
        }, { dmChannelId, msg: 'original dm ' + ts });
        await page2.waitForTimeout(3000);

        // A edits via the real UI (hover → edit → save).
        await page.hover('.message >> nth=0');
        await page.waitForSelector('[data-action="edit"]', { timeout: 5000 });
        await page.click('[data-action="edit"]');
        await page.waitForSelector('.edit-textarea', { timeout: 5000 });
        await page.fill('.edit-textarea', 'EDITED LIVE ' + ts);
        await page.click('.edit-save-btn');
        await page2.waitForTimeout(4000);

        // B must see the edit live WITHOUT any reload (regression: handleEditedMessage
        // fetched identity by the HMAC sender_id → 404 → edit silently dropped).
        const bTexts = await page2.locator('.message .text').allTextContents();
        expect(bTexts.some(t => t && t.includes('EDITED LIVE ' + ts))).toBeTruthy();
        await expect(page2.locator('.edited-label').first()).toBeVisible({ timeout: 5000 });
        await ctx2.close();
    });
});
