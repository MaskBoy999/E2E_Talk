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

test.describe('Server Channel Message Persistence', () => {

    test('server channel messages persist after full page refresh', async ({ page }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const username = 'svpersist_' + ts;
        const testMessage = 'Server msg persist test ' + ts;

        // Register and create server
        const body = await registerUser(page, username);
        const { serverId, channelId } = await createServerAndKey(page, body.token, body.user.id);

        // Navigate UI to server channel
        await page.evaluate(async () => { await loadServers(); });
        await page.waitForTimeout(2000);
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(2000);

        // Send a message via the UI (fill input, click send)
        const input = page.locator('#message-input');
        await expect(input).toBeEnabled({ timeout: 15000 });
        await input.fill(testMessage);
        await page.click('#send-btn');
        await page.waitForTimeout(4000);

        // Verify message appears in UI
        let msgTexts = await page.locator('.message .text').allTextContents();
        console.log('Before reload msg texts:', JSON.stringify(msgTexts));
        expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();

        // FULL PAGE RELOAD
        await page.reload();
        await page.waitForTimeout(3000);
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 15000 });

        // Navigate to server channel again
        await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
        await page.click('.server-icon:not(.add-server)');
        await page.waitForSelector('.channel-item', { timeout: 15000 });
        await page.click('.channel-item >> nth=0');
        await page.waitForTimeout(5000);

        // Verify message persists after reload
        await expect(async () => {
            msgTexts = await page.locator('.message .text').allTextContents();
            console.log('After reload msg texts:', JSON.stringify(msgTexts));
            expect(msgTexts.some(t => t && t.includes(testMessage))).toBeTruthy();
        }).toPass({ timeout: 25000 });

        console.log('=== SERVER CHANNEL PERSISTENCE TEST PASSED ===');
    });

});
