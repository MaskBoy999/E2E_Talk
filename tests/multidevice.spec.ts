import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Multi-Device', () => {

    async function registerUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.waitForSelector('#show-register');
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
                await page.fill('#register-confirm-password', 'password123');
await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    async function loginUser(page: any, username: string) {
        await page.goto(`${BASE}/login.html`);
        await page.fill('#login-username', username);
        await page.fill('#login-password', 'password123');
        await page.click('#login-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
        return await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));
    }

    async function waitForWsOpen(page: any, timeoutMs = 5000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const open = await page.evaluate(() => typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN);
            if (open) return true;
            await page.waitForTimeout(200);
        }
        return false;
    }

    test('second device recovers identity key from key blob and decrypts server messages', async ({ browser }) => {
        const ts = Date.now();
        const username = 'md_srv_' + ts;

        const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page1 = await ctx1.newPage();
        const { token: token1 } = await registerUser(page1, username);

        const kp1 = await page1.evaluate(() => {
            const kp = E2ECrypto.getIdentityKeyPair();
            return kp ? { pub: E2ECrypto.arrayBufferToBase64(kp.publicKey), priv: E2ECrypto.arrayBufferToBase64(kp.privateKey) } : null;
        });
        expect(kp1).toBeTruthy();

        // Create server via API
        const inviteCode = await page1.evaluate(() => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let code = '';
            for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
            return code;
        });
        const inviteCodeHash = await page1.evaluate((code: string) => E2ECrypto.sha256Hex(code), inviteCode);

        const createRes = await page1.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { name: 'TestServer_' + ts, invite_code: inviteCode },
        });
        expect(createRes.ok()).toBeTruthy();
        const serverData = await createRes.json();
        const serverId = serverData.id;

        // Generate + save + upload server key (like chat.js createServer)
        const keySetup = await page1.evaluate(async ({ serverId, token }: { serverId: string; token: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            const res = await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    user_id: user.id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                })
            });
            return { ok: res.ok, status: res.status };
        }, { serverId, token: token1 });
        expect(keySetup.ok).toBeTruthy();

        // Get general channel
        const chRes = await page1.request.get(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        const channels = await chRes.json();
        const general = channels.find((c: any) => c.name === 'general');
        expect(general).toBeTruthy();
        const channelId = general.id;

        // Device 1: connect WS + select channel + send message
        await page1.evaluate(() => { if (typeof loadServers === 'function') loadServers(); });
        await page1.waitForTimeout(1000);

        const wsReady = await waitForWsOpen(page1);
        expect(wsReady).toBeTruthy();

        const encResult = await page1.evaluate(({ plaintext, channelId, serverId }) => {
            return E2ECrypto.encryptMessage(plaintext, E2ECrypto.getServerKey(serverId));
        }, { plaintext: 'Hello from device 1!', channelId, serverId });

        await page1.evaluate(({ channelId, encResult }) => {
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: encResult.ciphertext,
                nonce: encResult.nonce,
                message_nonce: encResult.messageNonce,
            }));
        }, { channelId, encResult });
        await page1.waitForTimeout(1000);

        // Debug: verify crypto.js version loaded
        const cryptoVer = await page1.evaluate(() => {
            // Directly test encryption
            const testKey = E2ECrypto.x25519GenerateKeyPair();
            const testPrivB64 = E2ECrypto.arrayBufferToBase64(testKey.privateKey);
            const privBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(testPrivB64));
            
            // Manually encrypt using internal functions (they're not exposed, so test via encryptKeyForEscrow)
            const escrow = E2ECrypto.encryptKeyForEscrow(testPrivB64, 'testpassword');
            
            // Decode the encrypted key and check sizes
            const encBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(escrow.encrypted_private_key));
            const saltBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(escrow.salt));
            const nonceBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(escrow.nonce));
            
            return {
                privBytesLen: privBytes.length,
                testPrivB64Len: testPrivB64.length,
                encBytesLen: encBytes.length,
                saltBytesLen: saltBytes.length,
                nonceBytesLen: nonceBytes.length,
                encB64Len: escrow.encrypted_private_key.length,
            };
        });
        console.log('Crypto test encrypt:', JSON.stringify(cryptoVer));

        // Device 2: login with same account
        const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        const { token: token2 } = await loginUser(page2, username);

        // Debug: check identity key status on device 2
        const debugInfo = await page2.evaluate(() => {
            const user = JSON.parse(localStorage.getItem('user') || 'null');
            const token = localStorage.getItem('token');
            const kp = E2ECrypto.getIdentityKeyPair();
            const url = window.location.href;
            const e2eKeys = Object.keys(localStorage).filter(k => k.startsWith('e2e_'));
            const cryptoVersion = typeof E2ECrypto !== 'undefined' ? 'loaded' : 'missing';
            return { hasUser: !!user, userId: user?.id, hasToken: !!token, hasIdentity: !!kp, url, e2eKeys, cryptoVersion };
        });
        console.log('Device 2 debug:', JSON.stringify(debugInfo));


        // Device 2: fetch and decrypt server key
        const serverKeyOk = await page2.evaluate(async ({ serverId, token }: { serverId: string; token: string }) => {
            const res = await fetch('/api/servers/' + serverId + '/keys', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const keys = await res.json();
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return 'no_identity';
            for (const entry of keys) {
                try {
                    const serverKey = E2ECrypto.envelopeDecryptRaw(
                        entry.encrypted_key, entry.nonce, entry.sender_public_key, identity.privateKey
                    );
                    E2ECrypto.saveServerKey(serverId, serverKey);
                    return 'ok';
                } catch (e) { return 'decrypt_err: ' + e; }
            }
            return keys.length === 0 ? 'no_keys' : 'decrypt_failed';
        }, { serverId, token: token2 });
        expect(serverKeyOk).toBe('ok');

        // Device 2: fetch messages and decrypt
        const decrypted = await page2.evaluate(async ({ channelId, serverId, token }: { channelId: string; serverId: string; token: string }) => {
            const res = await fetch('/api/channels/' + channelId + '/messages', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const messages = await res.json();
            if (!messages.length) return 'no_messages';
            const msg = messages[messages.length - 1];
            return E2ECrypto.decryptMessage(msg.encrypted_content, msg.nonce, E2ECrypto.getServerKey(serverId));
        }, { channelId, serverId, token: token2 });
        expect(decrypted).toBe('Hello from device 1!');

        await ctx1.close();
        await ctx2.close();
    });

    test('second device recovers identity key and decrypts DMs', async ({ browser }) => {
        const ts = Date.now();
        const user1 = 'md_dm1_' + ts;
        const user2 = 'md_dm2_' + ts;

        // Register user1
        const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page1 = await ctx1.newPage();
        const { token: token1 } = await registerUser(page1, user1);

        // Register user2 and get friend code
        const ctx2reg = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2reg = await ctx2reg.newPage();
        const { token: token2reg, user: user2Obj } = await registerUser(page2reg, user2);
        const user2Id = user2Obj.id;
        const user2_friend_code = await page2reg.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user2_friend_code).toBeTruthy();
        await ctx2reg.close();

        // Friend request
        const frRes = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: user2_friend_code },
        });
        expect(frRes.ok()).toBeTruthy();

        // User2 accepts
        const ctx2temp = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2temp = await ctx2temp.newPage();
        const { token: token2temp } = await loginUser(page2temp, user2);

        const incomingRes = await page2temp.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${token2temp}` },
        });
        const incoming = await incomingRes.json();
        expect(incoming.length).toBe(1);
        const acceptRes = await page2temp.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${token2temp}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acceptRes.ok()).toBeTruthy();
        await ctx2temp.close();

        // Create DM
        const dmRes = await page1.request.post(`${BASE}/api/dm/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        });
        expect(dmRes.ok()).toBeTruthy();
        const dmData = await dmRes.json();
        const dmId = dmData.id;

        // Get user2's public key
        const user2KeyRes = await page1.request.get(`${BASE}/api/identity/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        const user2PubKeyData = await user2KeyRes.json();
        const user2PubKey = user2PubKeyData.identity_public_key;

        // Device 1: connect WS + send DM
        await page1.evaluate(() => { if (typeof loadServers === 'function') loadServers(); });
        await page1.waitForTimeout(1000);
        const wsReady = await waitForWsOpen(page1);
        expect(wsReady).toBeTruthy();

        const encDm = await page1.evaluate(({ plaintext, dmChannelId, otherPubKey }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPubKey));
            return E2ECrypto.encryptDm(plaintext, dmChannelId, kp.privateKey, pubBytes);
        }, { plaintext: 'Hello from device 1 DM!', dmChannelId: dmId, otherPubKey: user2PubKey });

        await page1.evaluate(({ dmId, encDm }) => {
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmId,
                encrypted_content: encDm.ciphertext,
                nonce: encDm.nonce,
                message_nonce: encDm.messageNonce || null,
            }));
        }, { dmId, encDm });
        await page1.waitForTimeout(1000);

        // Device 2: login as user1 (same account)
        const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        const { token: token2 } = await loginUser(page2, user1);

        // Device 2: fetch DM messages and decrypt
        const decrypted = await page2.evaluate(async ({ dmId, otherPubKey, token }: { dmId: string; otherPubKey: string; token: string }) => {
            const res = await fetch('/api/dm/' + dmId + '/messages', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const messages = await res.json();
            if (!messages.length) return 'no_messages';
            const msg = messages[messages.length - 1];
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return 'no_identity';
            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPubKey));
            return E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, dmId, kp.privateKey, pubBytes, msg.message_nonce);
        }, { dmId, otherPubKey: user2PubKey, token: token2 });
        expect(decrypted).toBe('Hello from device 1 DM!');

        // Verify same identity key
        const kp2 = await page2.evaluate(() => {
            const kp = E2ECrypto.getIdentityKeyPair();
            return kp ? { priv: E2ECrypto.arrayBufferToBase64(kp.privateKey) } : null;
        });
        expect(kp2).toBeTruthy();
        const kp1Priv = await page1.evaluate(() => {
            const kp = E2ECrypto.getIdentityKeyPair();
            return kp ? E2ECrypto.arrayBufferToBase64(kp.privateKey) : null;
        });
        expect(kp2!.priv).toBe(kp1Priv);

        await ctx1.close();
        await ctx2.close();
    });

    test('second device can send messages that first device decrypts', async ({ browser }) => {
        const ts = Date.now();
        const username = 'md_send_' + ts;

        // Device 1: register + create server
        const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page1 = await ctx1.newPage();
        const { token: token1 } = await registerUser(page1, username);

        const inviteCode = await page1.evaluate(() => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let code = '';
            for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
            return code;
        });
        const inviteCodeHash = await page1.evaluate((code: string) => E2ECrypto.sha256Hex(code), inviteCode);

        const createRes = await page1.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { name: 'SendServer_' + ts, invite_code: inviteCode },
        });
        expect(createRes.ok()).toBeTruthy();
        const serverData = await createRes.json();
        const serverId = serverData.id;

        // Device 1: generate + save + upload server key
        await page1.evaluate(async ({ serverId, token }: { serverId: string; token: string }) => {
            const serverKey = E2ECrypto.generateSymmetricKey();
            E2ECrypto.saveServerKey(serverId, serverKey);
            const identity = E2ECrypto.getIdentityKeyPair();
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
            await fetch(`/api/servers/${serverId}/keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    user_id: user.id,
                    encrypted_key: encrypted.ciphertext,
                    sender_public_key: encrypted.ephemeralPublicKey,
                    nonce: encrypted.nonce,
                })
            });
        }, { serverId, token: token1 });

        const chRes = await page1.request.get(`${BASE}/api/servers/${serverId}/channels`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        const channels = await chRes.json();
        const general = channels.find((c: any) => c.name === 'general');
        const channelId = general.id;

        // Device 2: login with same account
        const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        const { token: token2 } = await loginUser(page2, username);

        // Device 2: fetch and decrypt server key
        const keyOk = await page2.evaluate(async ({ serverId, token }: { serverId: string; token: string }) => {
            const res = await fetch('/api/servers/' + serverId + '/keys', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const keys = await res.json();
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) return 'no_identity';
            for (const entry of keys) {
                try {
                    const serverKey = E2ECrypto.envelopeDecryptRaw(
                        entry.encrypted_key, entry.nonce, entry.sender_public_key, identity.privateKey
                    );
                    E2ECrypto.saveServerKey(serverId, serverKey);
                    return 'ok';
                } catch (e) { return 'err: ' + e; }
            }
            return keys.length === 0 ? 'no_keys' : 'decrypt_failed';
        }, { serverId, token: token2 });
        expect(keyOk).toBe('ok');

        // Device 2: connect WS + send message
        await page2.evaluate(() => { if (typeof loadServers === 'function') loadServers(); });
        await page2.waitForTimeout(1000);
        const wsReady = await waitForWsOpen(page2);
        expect(wsReady).toBeTruthy();

        const enc2 = await page2.evaluate(({ plaintext, channelId, serverId }) => {
            return E2ECrypto.encryptMessage(plaintext, E2ECrypto.getServerKey(serverId));
        }, { plaintext: 'Hello from device 2!', channelId, serverId });

        await page2.evaluate(({ channelId, enc2 }) => {
            ws.send(JSON.stringify({
                type: 'message_send',
                channel_id: channelId,
                encrypted_content: enc2.ciphertext,
                nonce: enc2.nonce,
                message_nonce: enc2.messageNonce,
            }));
        }, { channelId, enc2 });
        await page2.waitForTimeout(1000);

        // Device 1: fetch messages and decrypt
        const decrypted = await page1.evaluate(async ({ channelId, serverId, token }: { channelId: string; serverId: string; token: string }) => {
            const res = await fetch('/api/channels/' + channelId + '/messages', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const messages = await res.json();
            if (!messages.length) return 'no_messages';
            const msg = messages[messages.length - 1];
            return E2ECrypto.decryptMessage(msg.encrypted_content, msg.nonce, E2ECrypto.getServerKey(serverId));
        }, { channelId, serverId, token: token1 });
        expect(decrypted).toBe('Hello from device 2!');

        await ctx1.close();
        await ctx2.close();
    });

    test('second device can send DMs that first device decrypts', async ({ browser }) => {
        const ts = Date.now();
        const user1 = 'md_dmsnd1_' + ts;
        const user2 = 'md_dmsnd2_' + ts;

        // Register user1
        const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page1 = await ctx1.newPage();
        const { token: token1 } = await registerUser(page1, user1);

        // Register user2 and get friend code
        const ctx2reg = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2reg = await ctx2reg.newPage();
        const { user: user2Obj } = await registerUser(page2reg, user2);
        const user2Id = user2Obj.id;
        const user2_friend_code = await page2reg.evaluate(() => localStorage.getItem('e2e_friend_code'));
        expect(user2_friend_code).toBeTruthy();
        await ctx2reg.close();

        // Friend request + accept
        const frRes = await page1.request.post(`${BASE}/api/friends/request`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
            data: { friend_code: user2_friend_code },
        });
        expect(frRes.ok()).toBeTruthy();

        const ctxTemp = await browser.newContext({ ignoreHTTPSErrors: true });
        const pageTemp = await ctxTemp.newPage();
        const { token: tokenTemp } = await loginUser(pageTemp, user2);

        const incomingRes = await pageTemp.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${tokenTemp}` },
        });
        const incoming = await incomingRes.json();
        expect(incoming.length).toBe(1);
        const acceptRes = await pageTemp.request.post(`${BASE}/api/friends/requests/accept`, {
            headers: { Authorization: `Bearer ${tokenTemp}`, 'Content-Type': 'application/json' },
            data: { request_id: incoming[0].id },
        });
        expect(acceptRes.ok()).toBeTruthy();
        await ctxTemp.close();

        // Create DM
        const dmRes = await page1.request.post(`${BASE}/api/dm/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
        });
        expect(dmRes.ok()).toBeTruthy();
        const dmData = await dmRes.json();
        const dmId = dmData.id;

        // Get user2's public key
        const user2KeyRes = await page1.request.get(`${BASE}/api/identity/${user2Id}`, {
            headers: { Authorization: `Bearer ${token1}` },
        });
        const user2PubKeyData = await user2KeyRes.json();
        const user2PubKey = user2PubKeyData.identity_public_key;

        // Device 2: login as user1
        const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const page2 = await ctx2.newPage();
        const { token: token2 } = await loginUser(page2, user1);

        // Device 2: connect WS + send DM
        await page2.evaluate(() => { if (typeof loadServers === 'function') loadServers(); });
        await page2.waitForTimeout(1000);
        const wsReady = await waitForWsOpen(page2);
        expect(wsReady).toBeTruthy();

        const enc2 = await page2.evaluate(({ plaintext, dmChannelId, otherPubKey }) => {
            const kp = E2ECrypto.getIdentityKeyPair();
            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPubKey));
            return E2ECrypto.encryptDm(plaintext, dmChannelId, kp.privateKey, pubBytes);
        }, { plaintext: 'Hello from device 2 DM!', dmChannelId: dmId, otherPubKey: user2PubKey });

        await page2.evaluate(({ dmId, enc2 }) => {
            ws.send(JSON.stringify({
                type: 'dm_send',
                dm_channel_id: dmId,
                encrypted_content: enc2.ciphertext,
                nonce: enc2.nonce,
                message_nonce: enc2.messageNonce || null,
            }));
        }, { dmId, enc2 });
        await page2.waitForTimeout(1000);

        // Device 1: fetch DM messages and decrypt
        const decrypted = await page1.evaluate(async ({ dmId, otherPubKey, token }: { dmId: string; otherPubKey: string; token: string }) => {
            const res = await fetch('/api/dm/' + dmId + '/messages', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const messages = await res.json();
            if (!messages.length) return 'no_messages';
            const msg = messages[messages.length - 1];
            const kp = E2ECrypto.getIdentityKeyPair();
            if (!kp) return 'no_identity';
            const pubBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(otherPubKey));
            return E2ECrypto.decryptDm(msg.encrypted_content, msg.nonce, dmId, kp.privateKey, pubBytes, msg.message_nonce);
        }, { dmId, otherPubKey: user2PubKey, token: token1 });
        expect(decrypted).toBe('Hello from device 2 DM!');

        await ctx1.close();
        await ctx2.close();
    });
});
