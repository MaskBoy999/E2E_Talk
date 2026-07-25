import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string {
    return createHash('sha256').update(data).digest('hex');
}

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(2000);
    return page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function createServerWithKey(page: any, token: string, ownerId: string, inviteCode: string) {
    const res = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: 'OfflineTest', invite_code_hash: sha256Hex(inviteCode) },
    });
    const server = await res.json();

    await page.evaluate(async ({ serverId, userId }) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({
                user_id: userId,
                encrypted_key: encrypted.ciphertext,
                sender_public_key: encrypted.ephemeralPublicKey,
                nonce: encrypted.nonce,
            }),
        });
    }, { serverId: server.id, userId: ownerId });

    return server;
}

async function uploadServerKeyForUser(page: any, serverId: string, targetUserId: string, targetPubKeyB64: string) {
    await page.evaluate(async ({ serverId, userId, pubKey }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubKey));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({
                user_id: userId,
                encrypted_key: encrypted.ciphertext,
                sender_public_key: encrypted.ephemeralPublicKey,
                nonce: encrypted.nonce,
            }),
        });
    }, { serverId, userId: targetUserId, pubKey: targetPubKeyB64 });
}

async function loadChatAndSelectChannel(page: any) {
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(1500);
    await page.waitForSelector('#message-input:not([disabled])', { timeout: 10000 });
}

async function reconnectUser(page: any) {
    // Navigate to index.html — the WS will reconnect automatically because
    // the token is still in localStorage (shared within the same browser context)
    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.waitForTimeout(3000);
    // Give time for WS reconnection and pending event replay
    await page.waitForTimeout(5000);
}

test.describe('Offline Key Provisioning Scenarios', () => {

    test('owner offline during kick: pending event replayed, key rotated on reconnect', async ({ page, context }) => {
        const ts = Date.now();
        const ownerName = 'offkick_' + ts;
        const kickedName = 'offkicked_' + ts;
        const inviteCode = generateCode(8);

        // 1. Register owner
        const ownerBody = await registerUser(page, ownerName);
        const server = await createServerWithKey(page, ownerBody.token, ownerBody.user.id, inviteCode);

        // Get channel ID for later access checks
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // 2. Register kicked user in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const kickedBody = await registerUser(page2, kickedName);

        // Join via API
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${kickedBody.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Owner uploads the server key for the kicked user
        const joinerPubKey = await page2.evaluate(() =>
            E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)
        );
        const joinerUserId = await page2.evaluate(() =>
            JSON.parse(localStorage.getItem('user') || '{}').id
        );
        await uploadServerKeyForUser(page, server.id, joinerUserId, joinerPubKey);

        // 3. Both load chat and verify messages work before the kick
        await loadChatAndSelectChannel(page);
        await loadChatAndSelectChannel(page2);

        await page.fill('#message-input', 'Before offline kick');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        const ownerMsgs1 = await page.locator('.message .text').allTextContents();
        expect(ownerMsgs1.some(t => t.includes('Before offline kick'))).toBeTruthy();
        const kickedMsgs1 = await page2.locator('.message .text').allTextContents();
        expect(kickedMsgs1.some(t => t.includes('Before offline kick'))).toBeTruthy();

        // 4. Close owner's page — WS disconnects (owner goes offline)
        await page.close();

        // 5. Make kick API call using owner's token — owner is offline, so pending event is saved
        const kickRes = await page2.request.post(`${BASE}/api/servers/${server.id}/members/kick`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { user_id: kickedBody.user.id },
        });
        expect(kickRes.ok()).toBeTruthy();

        // 6. Owner reconnects: same context, navigate to index.html (WS reconnects,
        //    pending member_kicked is replayed, client calls rotateServerKey())
        const page3 = await context.newPage();
        await reconnectUser(page3);

        // 7. Verify owner can still access server and send messages after rotation
        await loadChatAndSelectChannel(page3);
        await page3.fill('#message-input', 'After offline kick');
        await page3.click('#send-btn');
        await page3.waitForTimeout(2000);

        const ownerMsgs2 = await page3.locator('.message .text').allTextContents();
        expect(ownerMsgs2.some(t => t.includes('After offline kick'))).toBeTruthy();

        // 8. Verify kicked user gets 403 on server resources
        const kickedChRes = await page2.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${kickedBody.token}` },
        });
        expect(kickedChRes.status()).toBe(403);

        const kickedMsgRes = await page2.request.get(`${BASE}/api/channels/${channelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${kickedBody.token}` },
        });
        expect(kickedMsgRes.status()).toBe(403);

        await page2.close();
        await ctx2.close();
        await page3.close();
    });

    test('all members offline during join: new member gets key when member reconnects', async ({ page, context }) => {
        const ts = Date.now();
        const ownerName = 'offjoin_' + ts;
        const newMemberName = 'newmember_' + ts;
        const inviteCode = generateCode(8);

        // 1. Register owner and create server with key
        const ownerBody = await registerUser(page, ownerName);
        const server = await createServerWithKey(page, ownerBody.token, ownerBody.user.id, inviteCode);

        // Get channel ID
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // 2. Owner loads chat (establishes WS as the only online member)
        await loadChatAndSelectChannel(page);

        // 3. Close owner's page — all existing members go offline
        await page.close();

        // 4. New member registers in separate context and joins via API (all members offline at join time)
        const ctxMember = await context.browser()!.newContext();
        const page2 = await ctxMember.newPage();
        const newMemberBody = await registerUser(page2, newMemberName);
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${newMemberBody.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // 5. New member loads chat — server icon appears but no key provisioned yet
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page2.waitForTimeout(3000);

        // Verify: fetchAndDecryptServerKey returns false (no key uploaded for this user)
        const canDecryptBefore = await page2.evaluate(async (sid) => {
            try {
                if (typeof fetchAndDecryptServerKey === 'function') {
                    return await fetchAndDecryptServerKey(sid);
                }
            } catch (_) {}
            return false;
        }, server.id);
        expect(canDecryptBefore).toBeFalsy();

        // 6. Owner reconnects (same context) — receives pending key_needed event,
        //    client calls uploadServerKeyForUser() to provision the key
        const page3 = await context.newPage();
        await reconnectUser(page3);

        // 7. New member retries key decryption — should succeed now
        let canDecryptAfter = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            try {
                canDecryptAfter = await page2.evaluate(async (sid) => {
                    if (typeof fetchAndDecryptServerKey === 'function') {
                        return await fetchAndDecryptServerKey(sid);
                    }
                    return false;
                }, server.id);
            } catch (_) {}
            if (canDecryptAfter) break;
            await page2.waitForTimeout(2000);
        }
        expect(canDecryptAfter).toBeTruthy();
        console.log('New member decrypted server key after owner reconnected');

        // 8. Verify new member can select the channel and send a message
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.waitForTimeout(2000);
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(1500);
        await page2.waitForSelector('#message-input:not([disabled])', { timeout: 15000 });

        await page2.fill('#message-input', 'Joined via offline invite');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        const newMemberMsgs = await page2.locator('.message .text').allTextContents();
        expect(newMemberMsgs.some(t => t.includes('Joined via offline invite'))).toBeTruthy();

        // 9. Verify owner can also see the new member's message
        await loadChatAndSelectChannel(page3);
        await page3.waitForTimeout(2000);

        const ownerMsgs = await page3.locator('.message .text').allTextContents();
        expect(ownerMsgs.some(t => t.includes('Joined via offline invite'))).toBeTruthy();

        await page2.close();
        await ctxMember.close();
        await page3.close();
    });
});
