import { test, expect } from '@playwright/test';
const BASE = 'https://localhost:3443';

test.describe('DM Message Persistence', () => {
    test('identity and server keys persist across page reloads', async ({ page }) => {
        test.setTimeout(90000);
        page.setDefaultTimeout(60000);
        const ts = Date.now();
        const username = 'persist_' + ts;
        const password = 'password123';

        // Admin setup
        await page.goto(`${BASE}/admin.html`);
        await page.waitForSelector('#admin-password', { timeout: 10000 });
        await page.fill('#admin-password', 'admin');
        await page.click('#admin-login-form button[type="submit"]');
        await page.waitForTimeout(3000);

        // Register
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 10000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(3000);

        // Verify identity key exists
        const hasIdentityBefore = await page.evaluate(() => E2ECrypto.getIdentityKeyPair() !== null);
        expect(hasIdentityBefore).toBeTruthy();

        // Create a server using the same pattern as key-blob-recovery test
        const serverResult = await page.evaluate(async (ts: number) => {
            const name = 'PersistTest_' + ts;
            const channelKey = E2ECrypto.generateSymmetricKey();
            const encName = E2ECrypto.aeadEncrypt(name, channelKey);
            const encChName = E2ECrypto.aeadEncrypt('General', channelKey);
            const inviteCode = Array.from({length: 8}, () => 'abcdef0123456789'[Math.floor(Math.random()*16)]).join('');

            let hmacKey = localStorage.getItem('e2e_hmac_key');
            if (!hmacKey) {
                hmacKey = E2ECrypto.arrayBufferToBase64(E2ECrypto.randomBytes(32));
                localStorage.setItem('e2e_hmac_key', hmacKey);
            }
            const inviteCodeHash = E2ECrypto.hmacHex(hmacKey, inviteCode);

            const token = localStorage.getItem('token');
            const res = await fetch('/api/servers', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    encrypted_name: encName.ciphertext,
                    name_nonce: encName.nonce,
                    channel_encrypted_name: encChName.ciphertext,
                    channel_name_nonce: encChName.nonce,
                    invite_code_hash: inviteCodeHash,
                })
            });
            if (!res.ok) return { error: await res.text(), status: res.status };
            const serverData = await res.json();
            localStorage.setItem('e2e_invite_' + serverData.id, inviteCode);
            E2ECrypto.saveServerKey(serverData.id, channelKey);
            return serverData;
        }, ts);
        console.log('Server created:', serverResult.id);
        expect(serverResult.id).toBeTruthy();

        // Get server key
        const serverKeyBefore = await page.evaluate((sid: string) => E2ECrypto.getServerKey(sid), serverResult.id);
        expect(serverKeyBefore).toBeTruthy();

        // Reload page
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(5000);

        // Verify keys survived reload
        const hasIdentityAfter = await page.evaluate(() => E2ECrypto.getIdentityKeyPair() !== null);
        expect(hasIdentityAfter).toBeTruthy();

        const serverKeyAfter = await page.evaluate((sid: string) => E2ECrypto.getServerKey(sid), serverResult.id);
        expect(serverKeyAfter).toBeTruthy();

        // Verify server name decrypts
        const serverName = await page.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon');
            return icons.length > 0 ? (icons[0] as HTMLElement).title : null;
        });
        console.log('Server name after reload:', serverName);
        expect(serverName).toContain('PersistTest_');

        console.log('=== ALL PERSISTENCE CHECKS PASSED ===');
    });
});
