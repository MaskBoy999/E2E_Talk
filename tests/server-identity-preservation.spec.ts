import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function sha256Hex(data: string): string { return createHash('sha256').update(data).digest('hex'); }
// @ts-ignore
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

test.describe('Server Channel Identity Preservation After Reload', () => {

    test('messages from two users show distinct sender IDs and display names preserved after page reload', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const ownerName = 'srvowner_' + ts;
        const memberName = 'srvmember_' + ts;
        const serverName = 'IdentityTest_' + ts;
        const inviteCode = generateCode(8);

        // Register owner and member
        const ownerBody = await registerUser(page, ownerName);
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const memberBody = await registerUser(page2, memberName);

        // Owner creates a server
        const srv = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${ownerBody.token}`, 'Content-Type': 'application/json' },
            data: { name: serverName, invite_code: inviteCode },
        });
        const server = await srv.json();
        expect(server.id).toBeTruthy();

        // Owner saves server key
        await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: localStorage.getItem('token') ? JSON.parse(localStorage.getItem('user') || '{}').id : '', encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id });

        // Member joins via invite
        const joinRes = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${memberBody.token}` },
            data: { code: inviteCode },
        });
        expect(joinRes.ok()).toBeTruthy();

        // Owner sends server key to member
        const memberPubRes = await page2.request.get(`${BASE}/api/identity/${memberBody.user.id}`, {
            headers: { Authorization: `Bearer ${memberBody.token}` },
        });
        const memberPubData = await memberPubRes.json();

        await page.evaluate(async ({ serverId, pubKeyB64, memberId }: { serverId: string; pubKeyB64: string; memberId: string }) => {
            const serverKey = E2ECrypto.getServerKey(serverId);
            const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubKeyB64));
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ user_id: memberId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
            });
        }, { serverId: server.id, pubKeyB64: memberPubData.identity_public_key, memberId: memberBody.user.id });

        // ================================================================
        // Both users reload and send alternating messages
        // ================================================================
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(2000);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2000);

        // Owner sends 2 messages
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 10000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 10000 });
        await input.fill('Owner message 1');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);
        await input.fill('Owner message 2');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // Member sends 2 messages
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(2000);
        const input2 = page2.locator('#message-input');
        await expect(input2).toBeEnabled({ timeout: 10000 });
        await input2.fill('Member message 1');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);
        await input2.fill('Member message 2');
        await page2.click('#send-btn');
        await page2.waitForTimeout(2000);

        // Owner sends one more
        await page.bringToFront();
        await page.waitForTimeout(500);
        await input.fill('Owner message 3');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // ================================================================
        // Verify identity BEFORE reload
        // ================================================================
        await page2.bringToFront();
        await page2.waitForTimeout(1000);

        const msgsBefore = await page2.evaluate(() => {
            const msgEls = document.querySelectorAll('.message');
            return Array.from(msgEls).map(el => {
                const dnEl = el.querySelector('.display-name');
                return {
                    displayName: dnEl ? dnEl.textContent : null,
                    senderId: el.getAttribute('data-sender-id'),
                };
            });
        });
        console.log('Messages before reload:', JSON.stringify(msgsBefore, null, 2));
        expect(msgsBefore.length).toBeGreaterThanOrEqual(5);

        const namesBefore = [...new Set(msgsBefore.map(m => m.displayName).filter(Boolean))];
        console.log('Unique display names before reload:', namesBefore);
        expect(namesBefore.length).toBeGreaterThanOrEqual(2);

        const senderIdsBefore = [...new Set(msgsBefore.map(m => m.senderId).filter(Boolean))];
        console.log('Unique sender IDs before reload:', senderIdsBefore);
        expect(senderIdsBefore.length).toBeGreaterThanOrEqual(2);

        // ================================================================
        // Reload member page and verify
        // ================================================================
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(3000);
        await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
        await page2.click('.server-icon:not(.add-server)');
        await page2.waitForSelector('.channel-item', { timeout: 10000 });
        await page2.click('.channel-item >> nth=0');
        await page2.waitForTimeout(5000);

        const msgsAfter = await page2.evaluate(() => {
            const msgEls = document.querySelectorAll('.message');
            return Array.from(msgEls).map(el => {
                const dnEl = el.querySelector('.display-name');
                return {
                    displayName: dnEl ? dnEl.textContent : null,
                    senderId: el.getAttribute('data-sender-id'),
                };
            });
        });
        console.log('Messages after reload:', JSON.stringify(msgsAfter, null, 2));
        expect(msgsAfter.length).toBeGreaterThanOrEqual(5);

        const namesAfter = [...new Set(msgsAfter.map(m => m.displayName).filter(Boolean))];
        console.log('Unique display names after reload:', namesAfter);
        expect(namesAfter.length).toBeGreaterThanOrEqual(2);

        const senderIdsAfter = [...new Set(msgsAfter.map(m => m.senderId).filter(Boolean))];
        console.log('Unique sender IDs after reload:', senderIdsAfter);
        expect(senderIdsAfter.length).toBeGreaterThanOrEqual(2);

        // Verify displayName:senderId pairing is consistent
        const pairsAfter = [...new Set(msgsAfter.map(m => `${m.displayName}:${m.senderId}`))];
        console.log('Unique displayName:senderId pairs after reload:', pairsAfter);
        expect(pairsAfter.length).toBeGreaterThanOrEqual(2);

        // Verify that different users have different display names (not all the same)
        expect(namesAfter.length).toBeGreaterThanOrEqual(2);

        await page2.close();
        await ctx2.close();
    });
});
