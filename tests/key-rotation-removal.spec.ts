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
        data: { invite_code: inviteCode },
    });
    const server = await res.json();

    // Generate and upload server key for owner
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

async function joinServerAndGetKey(joinerPage: any, joinerToken: string, inviteCode: string, serverId: string, ownerPage: any) {
    const joinRes = await joinerPage.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${joinerToken}` },
        data: { code: inviteCode },
    });
    expect(joinRes.ok()).toBeTruthy();

    const userPubKey = await joinerPage.evaluate(() =>
        E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)
    );

    // Owner uploads the key for the new member
    const joinerUserId = await joinerPage.evaluate(() => JSON.parse(localStorage.getItem('user') || '{}').id);
    await ownerPage.evaluate(async ({ serverId, userId, userPubKey }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(userPubKey));
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
    }, { serverId, userId: joinerUserId, userPubKey });
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

async function sendMessage(page: any, text: string) {
    const input = page.locator('#message-input');
    await expect(input).toBeEnabled({ timeout: 5000 });
    await input.fill(text);
    await page.click('#send-btn');
    await page.waitForTimeout(2000);
}

async function getMessageTexts(page: any): Promise<string[]> {
    return await page.locator('.message .text').allTextContents();
}

test.describe('Server Key Rotation on Member Removal', () => {

    test('kick member: owner rotates key, kicked user cannot access server resources', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ownerName = 'kickown_' + ts;
        const kickedName = 'kicked_' + ts;
        const inviteCode = generateCode(8);

        // Register owner
        const ownerBody = await registerUser(page, ownerName);
        const server = await createServerWithKey(page, ownerBody.token, ownerBody.user.id, inviteCode);

        // Get a channel ID for later verification
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // Register kicked user in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const kickedBody = await registerUser(page2, kickedName);
        await joinServerAndGetKey(page2, kickedBody.token, inviteCode, server.id, page);

        // Both load chat
        await loadChatAndSelectChannel(page);
        await loadChatAndSelectChannel(page2);

        // Owner sends message — both should see it
        await sendMessage(page, 'Before kick');
        const ownerMsgs1 = await getMessageTexts(page);
        expect(ownerMsgs1.some(t => t.includes('Before kick'))).toBeTruthy();
        const kickedMsgs1 = await getMessageTexts(page2);
        expect(kickedMsgs1.some(t => t.includes('Before kick'))).toBeTruthy();

        // Owner kicks via API
        await page.request.post(`${BASE}/api/servers/${server.id}/members/kick`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { user_id: kickedBody.user.id },
        });
        await page.waitForTimeout(3000);

        // Owner sends message after kick — owner should see it with new key
        await sendMessage(page, 'After kick');

        const ownerMsgs2 = await getMessageTexts(page);
        expect(ownerMsgs2.some(t => t.includes('After kick'))).toBeTruthy();

        // Kicked user should get 403 when trying to access server resources
        const kickedChRes = await page2.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${kickedBody.token}` },
        });
        expect(kickedChRes.status()).toBe(403);

        const kickedMsgRes = await page2.request.get(`${BASE}/api/channels/${channelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${kickedBody.token}` },
        });
        expect(kickedMsgRes.status()).toBe(403);

        // Verify kicked user is no longer in the member list
        const membersRes = await page.request.get(`${BASE}/api/servers/${server.id}/members`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const members = await membersRes.json();
        expect(members.some((m: any) => m.id === kickedBody.user.id)).toBeFalsy();

        await page2.close();
        await ctx2.close();
    });

    test('ban member: owner rotates key, banned user cannot access server resources', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ownerName = 'banown_' + ts;
        const bannedName = 'banned_' + ts;
        const inviteCode = generateCode(8);

        // Register owner
        const ownerBody = await registerUser(page, ownerName);
        const server = await createServerWithKey(page, ownerBody.token, ownerBody.user.id, inviteCode);

        // Get a channel ID for later verification
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // Register banned user in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const bannedBody = await registerUser(page2, bannedName);
        await joinServerAndGetKey(page2, bannedBody.token, inviteCode, server.id, page);

        // Both load chat
        await loadChatAndSelectChannel(page);
        await loadChatAndSelectChannel(page2);

        // Owner sends message — both should see it
        await sendMessage(page, 'Before ban');
        const ownerMsgs1 = await getMessageTexts(page);
        expect(ownerMsgs1.some(t => t.includes('Before ban'))).toBeTruthy();
        const bannedMsgs1 = await getMessageTexts(page2);
        expect(bannedMsgs1.some(t => t.includes('Before ban'))).toBeTruthy();

        // Owner bans via API (correct endpoint)
        const banRes = await page.request.post(`${BASE}/api/servers/${server.id}/members/ban`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { user_id: bannedBody.user.id },
        });
        expect(banRes.ok()).toBeTruthy();
        await page.waitForTimeout(3000);

        // Owner sends message after ban
        await sendMessage(page, 'After ban');
        const ownerMsgs2 = await getMessageTexts(page);
        expect(ownerMsgs2.some(t => t.includes('After ban'))).toBeTruthy();

        // Banned user should get 403 when trying to access server resources
        const bannedChRes = await page2.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${bannedBody.token}` },
        });
        expect(bannedChRes.status()).toBe(403);

        const bannedMsgRes = await page2.request.get(`${BASE}/api/channels/${channelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${bannedBody.token}` },
        });
        expect(bannedMsgRes.status()).toBe(403);

        // Verify banned user is no longer in the member list
        const membersRes = await page.request.get(`${BASE}/api/servers/${server.id}/members`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const members = await membersRes.json();
        expect(members.some((m: any) => m.id === bannedBody.user.id)).toBeFalsy();

        // Verify ban appears in ban list
        const bansRes = await page.request.get(`${BASE}/api/servers/${server.id}/bans`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const bans = await bansRes.json();
        expect(bans.some((b: any) => b.id === bannedBody.user.id)).toBeTruthy();

        await page2.close();
        await ctx2.close();
    });

    test('member leaves: owner rotates key, leaver cannot access server resources', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ownerName = 'leaveown_' + ts;
        const leaverName = 'leaver_' + ts;
        const inviteCode = generateCode(8);

        // Register owner
        const ownerBody = await registerUser(page, ownerName);
        const server = await createServerWithKey(page, ownerBody.token, ownerBody.user.id, inviteCode);

        // Get a channel ID for later verification
        const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const channels = await chRes.json();
        const channelId = channels[0].id;

        // Register leaver in separate context
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const leaverBody = await registerUser(page2, leaverName);
        await joinServerAndGetKey(page2, leaverBody.token, inviteCode, server.id, page);

        // Both load chat
        await loadChatAndSelectChannel(page);
        await loadChatAndSelectChannel(page2);

        // Owner sends message — both should see it
        await sendMessage(page, 'Before leave');
        const ownerMsgs1 = await getMessageTexts(page);
        expect(ownerMsgs1.some(t => t.includes('Before leave'))).toBeTruthy();
        const leaverMsgs1 = await getMessageTexts(page2);
        expect(leaverMsgs1.some(t => t.includes('Before leave'))).toBeTruthy();

        // User2 leaves via API
        const leaveRes = await page2.request.post(`${BASE}/api/servers/${server.id}/leave`, {
            headers: { Authorization: `Bearer ${leaverBody.token}` },
        });
        expect(leaveRes.ok()).toBeTruthy();
        await page.waitForTimeout(3000);

        // Owner sends message after leave
        await sendMessage(page, 'After leave');
        const ownerMsgs2 = await getMessageTexts(page);
        expect(ownerMsgs2.some(t => t.includes('After leave'))).toBeTruthy();

        // Leaver should get 403 when trying to access server resources
        const leaverChRes = await page2.request.get(`${BASE}/api/servers/${server.id}/channels`, {
            headers: { Authorization: `Bearer ${leaverBody.token}` },
        });
        expect(leaverChRes.status()).toBe(403);

        const leaverMsgRes = await page2.request.get(`${BASE}/api/channels/${channelId}/messages?limit=50`, {
            headers: { Authorization: `Bearer ${leaverBody.token}` },
        });
        expect(leaverMsgRes.status()).toBe(403);

        // Verify leaver is no longer in the member list
        const membersRes = await page.request.get(`${BASE}/api/servers/${server.id}/members`, {
            headers: { Authorization: `Bearer ${ownerBody.token}` },
        });
        const members = await membersRes.json();
        expect(members.some((m: any) => m.id === leaverBody.user.id)).toBeFalsy();

        await page2.close();
        await ctx2.close();
    });
});
