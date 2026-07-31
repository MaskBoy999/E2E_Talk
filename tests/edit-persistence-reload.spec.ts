import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
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
    return { serverId: server.id, channelId: channels[0].id };
}

async function openChannel(page: any, channelId: string) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(2000);
}

async function editLastMessage(page: any, newText: string) {
    // Hover the first message to reveal the action buttons
    await page.hover('.message >> nth=0');
    await page.waitForSelector('[data-action="edit"]', { timeout: 5000 });
    await page.click('[data-action="edit"]');
    await page.waitForSelector('.edit-textarea', { timeout: 5000 });
    await page.fill('.edit-textarea', newText);
    await page.click('.edit-save-btn');
    await page.waitForTimeout(3000);
}

test.describe('Edit persistence after reload', () => {

    test('channel edit: edited content + (edited) label survive full page reload', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'editpersist_' + ts;
        const originalText = 'original edit test ' + ts;
        const editedText = 'EDITED version ' + ts;

        const body = await registerUser(page, username);
        const { channelId } = await createServerAndKey(page, body.token, body.user.id);

        await openChannel(page, channelId);

        // Send a message via the UI
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });
        await input.fill(originalText);
        await page.click('#send-btn');
        await page.waitForTimeout(3000);
        const sentTexts = await page.locator('.message .text').allTextContents();
        expect(sentTexts.some(t => t && t.includes(originalText))).toBeTruthy();

        // Edit the message via the UI (hover → edit → type → save)
        await editLastMessage(page, editedText);
        const editedTexts = await page.locator('.message .text').allTextContents();
        expect(editedTexts.some(t => t && t.includes(editedText))).toBeTruthy();
        // Live: the (edited) label should show
        await expect(page.locator('.edited-label').first()).toBeVisible({ timeout: 5000 });

        // FULL PAGE RELOAD — the whole point of the fix
        await page.reload();
        await page.waitForTimeout(3000);
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await openChannel(page, channelId);

        // Edited content must persist...
        await expect(async () => {
            const reloadTexts = await page.locator('.message .text').allTextContents();
            expect(reloadTexts.some(t => t && t.includes(editedText))).toBeTruthy();
        }).toPass({ timeout: 25000 });

        // ...and the (edited) label must persist too
        await expect(async () => {
            const label = await page.locator('.edited-label').first().textContent();
            expect(label).toContain('edited');
        }).toPass({ timeout: 25000 });
    });

    test('DM edit: edited content + (edited) label survive full page reload', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const user1 = 'dmedit_a_' + ts;
        const user2 = 'dmedit_b_' + ts;
        const originalText = 'original dm edit ' + ts;
        const editedText = 'DM EDITED ' + ts;

        // Register user2 in a separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Register user1 (main page)
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Become friends via API
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

        // Create the DM channel via API and resolve the other user's id
        const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        const dm = await page.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        });
        expect(dm.ok()).toBeTruthy();
        const dmChannel = await dm.json();
        const dmChannelId = dmChannel.id;

        // Open DM view and select the channel
        await page.goto(`${BASE}/index.html`);
        await page.waitForSelector('#dm-strip-btn', { timeout: 15000 });
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        const selected = await page.evaluate(async ({ dmChannelId, userId2 }: { dmChannelId: string; userId2: string }) => {
            for (let i = 0; i < 50; i++) {
                if (ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (typeof selectDmChannel === 'function') {
                try {
                    await selectDmChannel(dmChannelId, userId2, null, null);
                    return 'ok';
                } catch (e) {
                    return 'err: ' + e.message;
                }
            }
            return 'no-fn';
        }, { dmChannelId, userId2: userData.id });
        expect(selected).toContain('ok');
        await page.waitForTimeout(1000);

        // Send a DM message via WS
        const sendResult = await page.evaluate(async ({ dmChannelId, msg }: { dmChannelId: string; msg: string }) => {
            for (let i = 0; i < 50; i++) {
                if (ws && ws.readyState === WebSocket.OPEN) break;
                await new Promise(r => setTimeout(r, 100));
            }
            if (!currentDmOtherUser) return 'NO_OTHER_USER';
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return 'NO_IDENTITY_KEY';
            const res = await fetch('/api/identity/' + currentDmOtherUser.id, {
                headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
            });
            const data = await res.json();
            const otherPubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
            const encrypted = E2ECrypto.encryptDm(msg, dmChannelId, kp.privateKey, otherPubKey);
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmChannelId,
                encrypted_content: encrypted.ciphertext,
                nonce: encrypted.nonce,
                message_nonce: encrypted.messageNonce || null,
            }));
            return 'SENT';
        }, { dmChannelId, msg: originalText });
        expect(sendResult).toBe('SENT');
        await page.waitForTimeout(3000);

        const dmSent = await page.locator('.message .text').allTextContents();
        expect(dmSent.some(t => t && t.includes(originalText))).toBeTruthy();

        // Edit via UI
        await editLastMessage(page, editedText);
        const dmEdited = await page.locator('.message .text').allTextContents();
        expect(dmEdited.some(t => t && t.includes(editedText))).toBeTruthy();
        await expect(page.locator('.edited-label').first()).toBeVisible({ timeout: 5000 });

        // FULL PAGE RELOAD
        await page.reload();
        await page.waitForTimeout(3000);
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('.dm-item', { timeout: 10000 });
        await page.click('.dm-item');
        await page.waitForTimeout(3000);

        await expect(async () => {
            const reloadTexts = await page.locator('.message .text').allTextContents();
            expect(reloadTexts.some(t => t && t.includes(editedText))).toBeTruthy();
        }).toPass({ timeout: 25000 });

        await expect(async () => {
            const label = await page.locator('.edited-label').first().textContent();
            expect(label).toContain('edited');
        }).toPass({ timeout: 25000 });

        await ctx2.close();
    });
});
