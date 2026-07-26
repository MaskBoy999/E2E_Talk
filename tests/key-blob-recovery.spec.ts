import { test, expect } from '@playwright/test';
const BASE = 'https://localhost:3443';

test.describe('Key Blob Recovery: local data wipe resilience', () => {
    test('full recovery after localStorage wipe', async ({ page }) => {
        test.setTimeout(120000);
        page.setDefaultTimeout(90000);
        const ts = Date.now();
        const username = 'blob_' + ts;
        const password = 'password123';

        // STEP 0: Admin setup
        await page.goto(`${BASE}/admin.html`);
        await page.waitForSelector('#admin-password', { timeout: 10000 });
        await page.fill('#admin-password', 'admin');
        await page.click('#admin-login-form button[type="submit"]');
        await page.waitForTimeout(3000);
        const visible = await page.locator('#admin-panel').isVisible();
        expect(visible).toBeTruthy();

        // STEP 1: Register user
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register', { timeout: 10000 });
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', password);
        await page.fill('#register-confirm-password', password);
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForTimeout(3000);

        // STEP 2: Verify identity key exists
        const hasIdentity = await page.evaluate(() => E2ECrypto.getIdentityKeyPair() !== null);
        expect(hasIdentity).toBeTruthy();

        // STEP 3: Create server via createServer() (replicates full flow)
        const serverResult = await page.evaluate(async (ts: number) => {
            const name = 'Test_' + ts;
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

            // Save invite code and server key locally
            localStorage.setItem('e2e_invite_' + serverData.id, inviteCode);
            E2ECrypto.saveServerKey(serverData.id, channelKey);

            // Upload self key
            const identity = E2ECrypto.getIdentityKeyPair();
            if (identity) {
                const encrypted = E2ECrypto.envelopeEncrypt(channelKey, identity.publicKey, identity.privateKey);
                await fetch(`/api/servers/${serverData.id}/keys`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        user_id: serverData.owner_id || serverData.id,
                        encrypted_key: encrypted.ciphertext,
                        sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                        nonce: encrypted.nonce,
                    })
                });
            }
            return serverData;
        }, ts);

        console.log('Server result:', JSON.stringify(serverResult));
        expect(serverResult.error).toBeUndefined();
        expect(serverResult.id).toBeDefined();
        const serverId = serverResult.id;
        console.log('Server created:', serverId);

        // Verify server key
        const hasKey = await page.evaluate((sid: string) => !!E2ECrypto.getServerKey(sid), serverId);
        expect(hasKey).toBeTruthy();

        // Reload to get the servers loaded
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);

        // Verify server name shows
        const serverNameBefore = await page.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon');
            return icons.length > 0 ? (icons[0] as HTMLElement).title : null;
        });
        console.log('Server name before wipe:', serverNameBefore);
        expect(serverNameBefore).toContain('Test_');

        // STEP 4: Save key blob
        await page.waitForTimeout(3000);
        const saveResult = await page.evaluate(async (pw: string) => {
            try {
                const bundle = E2ECrypto.buildKeyBundle();
                const enc = E2ECrypto.encryptKeyBundle(bundle, pw);
                const t = localStorage.getItem('token');
                const res = await fetch('/api/key-blob', {
                    method: 'PUT',
                    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        encrypted_blob: enc.encrypted_private_key,
                        salt: enc.salt,
                        nonce: enc.nonce,
                    })
                });
                const text = await res.text();
                return { ok: res.ok, status: res.status, keyCount: Object.keys(bundle).length, response: text.substring(0, 200) };
            } catch (e: any) { return { error: e.message }; }
        }, password);
        console.log('Blob save:', JSON.stringify(saveResult));
        expect(saveResult.ok).toBeTruthy();

        // STEP 5: Verify blob on server
        const blobCheck = await page.evaluate(async () => {
            const t = localStorage.getItem('token');
            const res = await fetch('/api/key-blob', {
                headers: { Authorization: `Bearer ${t}` }
            });
            const text = await res.text();
            try {
                const data = JSON.parse(text);
                return { ok: res.ok, hasBlob: !!data.encrypted_blob, hasNonce: !!data.nonce };
            } catch { return { ok: res.ok, text: text.substring(0, 200) }; }
        });
        console.log('Blob check:', JSON.stringify(blobCheck));
        expect(blobCheck.hasBlob).toBeTruthy();

        // STEP 6: Wipe localStorage
        await page.evaluate(() => localStorage.clear());
        const wiped = await page.evaluate(() => E2ECrypto.getIdentityKeyPair() === null);
        expect(wiped).toBeTruthy();

        // STEP 7: Log back in (blob restores keys)
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#login-username', { timeout: 10000 });
        await page.fill('#login-username', username);
        await page.fill('#login-password', password);
        await page.click('#login-form button[type="submit"]');
        // Wait for either redirect to index.html or an error message
        try {
            await page.waitForURL('**/index.html', { timeout: 20000 });
        } catch (e) {
            // Check for error message on login page
            const errorVisible = await page.evaluate(() => {
                const errDiv = document.getElementById('login-error');
                return errDiv ? errDiv.textContent : 'no error element';
            });
            console.log('Login error state:', errorVisible, 'URL:', page.url());
            // Even if no redirect, check if we have a token
            const hasToken = await page.evaluate(() => !!localStorage.getItem('token'));
            console.log('Has token after login attempt:', hasToken);
            if (hasToken) {
                // Force navigation to index.html
                await page.goto(`${BASE}/index.html`);
            } else {
                throw e;
            }
        }
        await page.waitForTimeout(5000);

        // STEP 8: Verify identity key restored
        const identityRestored = await page.evaluate(() => E2ECrypto.getIdentityKeyPair() !== null);
        console.log('Identity restored:', identityRestored);
        expect(identityRestored).toBeTruthy();

        // STEP 9: Verify server key restored
        const keyRestored = await page.evaluate((sid: string) => !!E2ECrypto.getServerKey(sid), serverId);
        console.log('Server key restored:', keyRestored);
        expect(keyRestored).toBeTruthy();

        // STEP 10: Verify server name decrypts
        await page.waitForTimeout(2000);
        const serverNameAfter = await page.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon');
            return icons.length > 0 ? (icons[0] as HTMLElement).title : null;
        });
        console.log('Server name after restore:', serverNameAfter);
        expect(serverNameAfter).toContain('Test_');

        console.log('=== ALL CHECKS PASSED ===');
    });
});
