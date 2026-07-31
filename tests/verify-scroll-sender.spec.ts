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
    if (page.url().includes('admin')) {
        await page.fill('#admin-password', 'admin');
        await page.click('#admin-login-form button[type="submit"]');
        await page.waitForTimeout(2000);
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(500);
    }
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

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
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

// Mimics the real UI send flow (chat.js sendMessage): the sender's username is
// encrypted with the server key and included in the WS payload as
// encrypted_sender_username + sender_username_nonce.
async function sendServerMessageViaWs(page: any, channelId: string, serverId: string, text: string) {
    return await page.evaluate(async ({ channelId, serverId, text }) => {
        const key = E2ECrypto.getServerKey(serverId);
        if (!key) return 'no_key';
        const enc = E2ECrypto.encryptMessage(text, key);
        const payload: any = {
            type: 'message_send',
            channel_id: channelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        try {
            const myUser = JSON.parse(localStorage.getItem('user') || '{}');
            if (myUser.username) {
                const encUsername = E2ECrypto.encryptSenderUsername(myUser.username, key);
                if (encUsername) {
                    payload.encrypted_sender_username = encUsername.ciphertext;
                    payload.sender_username_nonce = encUsername.nonce;
                }
            }
        } catch (_) {}
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { channelId, serverId, text });
}

async function becomeFriendsViaApi(page1: any, page2: any, token1: string, token2: string) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBeTruthy();
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${token2}` },
    })).json();
    expect(Array.isArray(incoming)).toBe(true);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

// Mimics the real UI DM send flow (chat.js sendDmMessage): the sender's username
// is encrypted with the DM shared key (getDmKey) and included in the WS payload as
// encrypted_sender_username + sender_username_nonce — exactly what ws.rs:677 stores
// and appendDmMessage (chat.js:9746) decrypts to render the sender name.
async function sendDmMessageViaWs(page: any, dmChannelId: string, otherUserId: string, text: string) {
    return await page.evaluate(async ({ dmChannelId, otherUserId, text }) => {
        const kp = E2ECrypto.getIdentityKeyPair();
        if (!kp) return 'no_identity';
        const res = await fetch('/api/identity/' + otherUserId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        if (!data.identity_public_key) return 'no_pub_key';
        const otherPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(data.identity_public_key));
        const enc = E2ECrypto.encryptDm(text, dmChannelId, kp.privateKey, otherPub);
        const payload: any = {
            type: 'dm_send',
            dm_channel_id: dmChannelId,
            encrypted_content: enc.ciphertext,
            nonce: enc.nonce,
            message_nonce: enc.messageNonce || null,
        };
        try {
            const dmKey = E2ECrypto.getDmKey(dmChannelId, kp.privateKey, otherPub);
            if (dmKey) {
                const myUser = JSON.parse(localStorage.getItem('user') || '{}');
                if (myUser.username) {
                    const encUsername = E2ECrypto.encryptSenderUsername(myUser.username, dmKey);
                    if (encUsername) {
                        payload.encrypted_sender_username = encUsername.ciphertext;
                        payload.sender_username_nonce = encUsername.nonce;
                    }
                }
            }
        } catch (_) {}
        ws.send(JSON.stringify(payload));
        return 'sent';
    }, { dmChannelId, otherUserId, text });
}

test.describe('Verify infinite-scroll sender + edit/delete fixes', () => {

    test('scroll to top shows sender names and own-message edit/delete buttons', async ({ page }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const username = 'vscroll_' + ts;

        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);

        const wsOk = await waitForWs(page);
        expect(wsOk).toBe(true);

        // Send 60 messages (> PAGE_SIZE=50) so the initial load is capped and
        // scrolling to the top must fetch older messages.
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendServerMessageViaWs(page, channelId, serverId, `VerifyScroll msg ${i}`);
            expect(r).toBe('sent');
            await page.waitForTimeout(120);
        }
        await page.waitForTimeout(3000);

        // Confirm the API actually has all 60 messages
        const apiMsgs = await (await page.request.get(`${BASE}/api/channels/${channelId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${body.token}` },
        })).json();
        console.log(`API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);

        // Open the channel in the UI
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');

        // Wait until the initial PAGE_SIZE (50) batch is rendered, then assert
        // sender names + edit/delete buttons on the initial batch.
        let messageCount = 0;
        let editCount = 0;
        let deleteCount = 0;
        let nonEmptyNames = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            editCount = await page.locator('.message .msg-action-btn[data-action="edit"]').count();
            deleteCount = await page.locator('.message .msg-action-btn[data-action="delete"]').count();
            const names = await page.locator('.message .display-name').allTextContents();
            nonEmptyNames = names.filter((n: string) => n && n.trim().length > 0).length;
            console.log(`Initial batch: msgs=${messageCount} edit=${editCount} delete=${deleteCount} names=${names.length}/${nonEmptyNames}`);
            expect(messageCount).toBeGreaterThanOrEqual(50);
            expect(editCount).toBeGreaterThanOrEqual(40);
            expect(deleteCount).toBeGreaterThanOrEqual(40);
            expect(nonEmptyNames).toBeGreaterThanOrEqual(40);
        }).toPass({ timeout: 30000 });

        // Scroll to the top to trigger loading older messages
        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        // Wait for the older batch to load (message count must grow past the initial batch)
        await expect(async () => {
            const c = await page.locator('.message').count();
            console.log(`Rendered messages after scroll: ${c}`);
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        // Now verify ALL rendered messages (initial + prepended) have non-empty sender
        // names AND own-message edit/delete buttons — both fixes applied to prepended
        // messages.
        await expect(async () => {
            const allNames = await page.locator('.message .display-name').allTextContents();
            const allNonEmpty = allNames.filter((n: string) => n && n.trim().length > 0);
            const allEdit = await page.locator('.message .msg-action-btn[data-action="edit"]').count();
            const allDelete = await page.locator('.message .msg-action-btn[data-action="delete"]').count();
            const total = await page.locator('.message').count();
            console.log(`After scroll: msgs=${total} names=${allNames.length}/${allNonEmpty.length} edit=${allEdit} delete=${allDelete}`);
            // Every rendered message must have a sender name
            expect(allNames.length).toBe(total);
            expect(allNonEmpty.length).toBe(total);
            // Every own message must have edit/delete (all messages here are from this user)
            expect(allEdit).toBe(total);
            expect(allDelete).toBe(total);
        }).toPass({ timeout: 30000 });

        console.log('=== VERIFY SCROLL SENDER + EDIT/DELETE TEST PASSED ===');
    });

    test('DM variant: scroll to top shows sender names and own-message edit/delete buttons', async ({ page, context }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const user1 = 'vscroll_dm_a_' + ts;
        const user2 = 'vscroll_dm_b_' + ts;

        // Register user2 in a separate context (needed to accept the friend request)
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const body2 = await registerUser(page2, user2);
        expect(body2.token).toBeTruthy();

        // Register user1 on the main page
        const body1 = await registerUser(page, user1);
        expect(body1.token).toBeTruthy();

        // Become friends (creates the DM channel)
        await becomeFriendsViaApi(page, page2, body1.token, body2.token);

        // Resolve the DM channel id
        const convs = await (await page.request.get(`${BASE}/api/dm/conversations`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        expect(convs.length).toBeGreaterThanOrEqual(1);
        const dmId = convs[0].dm_channel_id;
        const otherUserId = convs[0].other_user_id;
        console.log('DM channel:', dmId, 'other:', otherUserId);

        const wsOk = await waitForWs(page);
        expect(wsOk).toBe(true);

        // Send 60 DM messages (> PAGE_SIZE=50) so the initial load is capped and
        // scrolling to the top must fetch older messages.
        const MSG_COUNT = 60;
        for (let i = 0; i < MSG_COUNT; i++) {
            const r = await sendDmMessageViaWs(page, dmId, otherUserId, `VerifyDmScroll msg ${i}`);
            expect(r).toBe('sent');
            await page.waitForTimeout(120);
        }
        await page.waitForTimeout(3000);

        // Confirm the API has all 60 messages
        const apiMsgs = await (await page.request.get(`${BASE}/api/dm/${dmId}/messages?limit=100`, {
            headers: { Authorization: `Bearer ${body1.token}` },
        })).json();
        console.log(`DM API messages: ${apiMsgs.length}`);
        expect(apiMsgs.length).toBeGreaterThanOrEqual(MSG_COUNT);

        // Open the DM view in the UI
        await page.click('#dm-strip-btn');
        await page.waitForTimeout(1500);
        await page.waitForSelector('.dm-item', { timeout: 15000 });
        await page.click('.dm-item');

        // Wait until the initial PAGE_SIZE (50) batch is rendered, then assert
        // sender names + edit/delete buttons on the initial batch.
        let messageCount = 0;
        let editCount = 0;
        let deleteCount = 0;
        let nonEmptyNames = 0;
        await expect(async () => {
            messageCount = await page.locator('.message').count();
            editCount = await page.locator('.message .msg-action-btn[data-action="edit"]').count();
            deleteCount = await page.locator('.message .msg-action-btn[data-action="delete"]').count();
            const names = await page.locator('.message .display-name').allTextContents();
            nonEmptyNames = names.filter((n: string) => n && n.trim().length > 0).length;
            console.log(`DM initial batch: msgs=${messageCount} edit=${editCount} delete=${deleteCount} names=${names.length}/${nonEmptyNames}`);
            expect(messageCount).toBeGreaterThanOrEqual(50);
            expect(editCount).toBeGreaterThanOrEqual(40);
            expect(deleteCount).toBeGreaterThanOrEqual(40);
            expect(nonEmptyNames).toBeGreaterThanOrEqual(40);
        }).toPass({ timeout: 30000 });

        // Scroll to the top to trigger loading older messages
        await page.evaluate(() => {
            const list = document.getElementById('message-list');
            if (list) list.scrollTop = 0;
        });

        // Wait for the older batch to load (message count must grow past the initial batch)
        await expect(async () => {
            const c = await page.locator('.message').count();
            console.log(`DM rendered messages after scroll: ${c}`);
            expect(c).toBeGreaterThan(messageCount);
        }).toPass({ timeout: 30000 });

        // Verify ALL rendered messages (initial + prepended) have non-empty sender
        // names AND own-message edit/delete buttons — both fixes applied to prepended
        // messages.
        await expect(async () => {
            const allNames = await page.locator('.message .display-name').allTextContents();
            const allNonEmpty = allNames.filter((n: string) => n && n.trim().length > 0);
            const allEdit = await page.locator('.message .msg-action-btn[data-action="edit"]').count();
            const allDelete = await page.locator('.message .msg-action-btn[data-action="delete"]').count();
            const total = await page.locator('.message').count();
            console.log(`DM after scroll: msgs=${total} names=${allNames.length}/${allNonEmpty.length} edit=${allEdit} delete=${allDelete}`);
            // Every rendered message must have a sender name
            expect(allNames.length).toBe(total);
            expect(allNonEmpty.length).toBe(total);
            // Every own message must have edit/delete (all messages here are from this user)
            expect(allEdit).toBe(total);
            expect(allDelete).toBe(total);
        }).toPass({ timeout: 30000 });

        console.log('=== VERIFY DM SCROLL SENDER + EDIT/DELETE TEST PASSED ===');

        await page2.close();
        await ctx2.close();
    });

});
