// Kick and ban now purge a member's server-scoped data exactly like leaving:
// their messages (and everything hanging off them), not just their membership.
// The owner must not be able to see a kicked/banned member's message anywhere.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass1234');
    await page.fill('#register-confirm-password', 'testpass1234');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
    return page.evaluate(() => ({
        token: localStorage.getItem('token') as string,
        user: JSON.parse(localStorage.getItem('user') || '{}') as { id: string },
    }));
}

/**
 * Owner creates a server and shares the key with a member who joined, then both
 * load the channel. Returns ids and the contexts so the caller can kick or ban.
 */
async function setupTwoMembers(page: Page, second: Page) {
    const owner = await page.evaluate(() => ({
        token: localStorage.getItem('token') as string,
        user: JSON.parse(localStorage.getItem('user') || '{}') as { id: string },
    }));
    const member = await second.evaluate(() => ({
        token: localStorage.getItem('token') as string,
        user: JSON.parse(localStorage.getItem('user') || '{}') as { id: string },
    }));

    const inviteCode = generateCode(8);
    const keys = await page.evaluate(() => {
        const key = E2ECrypto.generateSymmetricKey();
        return {
            keyB64: E2ECrypto.arrayBufferToBase64(key),
            encName: E2ECrypto.encryptMessage('Purge Test Server', key),
            encChName: E2ECrypto.encryptMessage('general', key),
        };
    });
    const srv = await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: keys.encName.ciphertext,
            name_nonce: keys.encName.nonce,
            channel_encrypted_name: keys.encChName.ciphertext,
            channel_name_nonce: keys.encChName.nonce,
        },
    });
    const server = await srv.json();

    // Owner uploads their own server key.
    await page.evaluate(async ({ serverId, userId, keyB64 }: { serverId: string; userId: string; keyB64: string }) => {
        const serverKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(keyB64));
        E2ECrypto.saveServerKey(serverId, serverKey);
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, E2ECrypto.getIdentityKeyPair().publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, userId: owner.user.id, keyB64: keys.keyB64 });

    // Register the invite, then the member joins.
    await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
        headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
        data: { invite_code: inviteCode },
    });
    await second.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${member.token}` },
        data: { code: inviteCode },
    });

    // Share the key with the member.
    const memberPubKey = await second.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
    await page.evaluate(async ({ serverId, memberId, memberPubKey }: { serverId: string; memberId: string; memberPubKey: string }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        const pub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(memberPubKey));
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, pub);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: memberId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, memberId: member.user.id, memberPubKey });

    // Both load the channel.
    for (const p of [page, second]) {
        await p.evaluate(async () => { await loadServers(); });
        await p.waitForTimeout(1200);
        await p.click('.server-icon:not(.add-server)');
        await p.waitForSelector('.channel-item', { timeout: 15000 });
        await p.click('.channel-item >> nth=0');
        await p.waitForTimeout(1500);
    }
    return { owner, member, serverId: server.id };
}

async function memberSends(second: Page, text: string) {
    await second.fill('#message-input', text);
    await second.click('#send-btn');
}

async function ownerSees(page: Page, text: string) {
    await expect(page.locator('.message .text').filter({ hasText: text })).toHaveCount(1, { timeout: 15000 });
}

/** Reload the owner straight back into the channel. */
async function ownerReopen(page: Page) {
    await page.reload();
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 20000 });
    await page.click('.server-icon:not(.add-server)');
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.click('.channel-item >> nth=0');
    await page.waitForTimeout(2000);
}

test.describe('kick / ban purge the member data', () => {
    test('a kicked member\'s messages are gone for the owner', async ({ page, context }) => {
        test.setTimeout(240000);
        await register(page, 'purgeowner_' + Date.now());
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await register(page2, 'purgemember_' + Date.now());

        const { owner, member, serverId } = await setupTwoMembers(page, page2);

        await memberSends(page2, 'member purge message');
        await ownerSees(page, 'member purge message');

        const kick = await page.request.post(`${BASE}/api/servers/${serverId}/members/kick`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { user_id: member.user.id },
        });
        expect(kick.ok()).toBeTruthy();

        // The row was deleted, not merely hidden: a fresh load cannot show it.
        await ownerReopen(page);
        await expect(page.locator('.message .text').filter({ hasText: 'member purge message' })).toHaveCount(0);

        await page2.close();
        await ctx2.close();
    });

    test('a banned member\'s messages are gone for the owner', async ({ page, context }) => {
        test.setTimeout(240000);
        await register(page, 'banowner_' + Date.now());
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        await register(page2, 'banmember_' + Date.now());

        const { owner, member, serverId } = await setupTwoMembers(page, page2);

        await memberSends(page2, 'member ban message');
        await ownerSees(page, 'member ban message');

        const ban = await page.request.post(`${BASE}/api/servers/${serverId}/members/ban`, {
            headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
            data: { user_id: member.user.id },
        });
        expect(ban.ok()).toBeTruthy();

        await ownerReopen(page);
        await expect(page.locator('.message .text').filter({ hasText: 'member ban message' })).toHaveCount(0);

        await page2.close();
        await ctx2.close();
    });
});
