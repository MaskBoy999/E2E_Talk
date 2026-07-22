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

function makeMinimalWav(): Buffer {
    const sampleRate = 8000;
    const duration = 0.3;
    const numSamples = Math.floor(sampleRate * duration);
    const dataSize = numSamples;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    const data = Buffer.alloc(dataSize, 128);
    return Buffer.concat([header, data]);
}

test.describe('Key rotation and notification sound sender_public_key fix', () => {

    test('rotateServerKey uploads identity.publicKey as sender_public_key (not undefined)', async ({ page }) => {
        const ts = Date.now();
        const username = 'rotfix_' + ts;

        // Register user
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Create server
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { name: 'RotFix ' + ts, invite_code_hash: sha256Hex(inviteCode) },
        });
        const server = await srvRes.json();
        expect(server.id).toBeTruthy();

        // Upload initial key for owner (using old envelopeEncryptRaw with ephemeral key)
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
        }, { serverId: server.id, userId: body.user.id });

        // Generate invite so server has at least one member entry
        await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { invite_code_hash: sha256Hex(inviteCode) },
        });

        // Call rotateServerKey directly via page.evaluate
        // This uses the fixed code: identity.publicKey instead of encrypted.ephemeralPublicKey
        const rotationResult = await page.evaluate(async (serverId: string) => {
            try {
                const result = await rotateServerKey(serverId);
                return { success: result, error: null };
            } catch (e: any) {
                return { success: false, error: e.message || String(e) };
            }
        }, server.id);
        expect(rotationResult.success).toBe(true);

        // Fetch the server keys from the API and verify sender_public_key
        const keysRes = await page.request.get(`${BASE}/api/servers/${server.id}/keys`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        const keys = await keysRes.json();
        expect(Array.isArray(keys)).toBe(true);
        expect(keys.length).toBeGreaterThanOrEqual(1);

        // Verify each key has a valid sender_public_key, and at least one matches identity.publicKey
        let foundIdentityPubKey = false;
        for (const key of keys) {
            expect(key.sender_public_key).toBeTruthy();
            expect(typeof key.sender_public_key).toBe('string');
            expect(key.sender_public_key.length).toBeGreaterThan(0);

            // Verify it decodes as valid base64 (X25519 public key = 32 bytes)
            const decodedLen = await page.evaluate((b64: string) => {
                try {
                    const bytes = E2ECrypto.base64ToArrayBuffer(b64);
                    return bytes.byteLength;
                } catch (e) {
                    return -1;
                }
            }, key.sender_public_key);
            expect(decodedLen).toBe(32);

            // Check if this key matches identity.publicKey (rotateServerKey entry).
            // The original setup upload used envelopeEncryptRaw with ephemeral key, so it won't match.
            const matchesIdentity = await page.evaluate((b64: string) => {
                try {
                    const storedKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(b64));
                    const identityPub = E2ECrypto.getIdentityKeyPair().publicKey;
                    if (storedKey.length !== identityPub.length) return false;
                    for (let i = 0; i < storedKey.length; i++) {
                        if (storedKey[i] !== identityPub[i]) return false;
                    }
                    return true;
                } catch (_) {
                    return false;
                }
            }, key.sender_public_key);
            if (matchesIdentity) foundIdentityPubKey = true;
        }
        // rotateServerKey entries should use identity.publicKey
        expect(foundIdentityPubKey).toBe(true);

        // Verify we can decrypt one of the key entries using its sender_public_key
        // (This simulates what fetchAndDecryptServerKey does)
        const canDecrypt = await page.evaluate(async (serverId: string) => {
            try {
                const res = await fetch(`/api/servers/${serverId}/keys`, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
                });
                const keys = await res.json();
                if (!Array.isArray(keys) || keys.length === 0) return false;
                const identity = E2ECrypto.getIdentityKeyPair();
                if (!identity) return false;
                for (const entry of keys) {
                    try {
                        const serverKey = E2ECrypto.envelopeDecrypt(
                            entry.encrypted_key,
                            identity.privateKey,
                            new Uint8Array(E2ECrypto.base64ToArrayBuffer(entry.sender_public_key)),
                            entry.nonce
                        );
                        if (serverKey && serverKey.length > 0) {
                            E2ECrypto.saveServerKey(serverId, serverKey);
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }
                return false;
            } catch (e) {
                return false;
            }
        }, server.id);
        expect(canDecrypt).toBe(true);
    });

    test('syncNotificationSoundToServer uploads identity.publicKey as sender_public_key (not undefined)', async ({ page }) => {
        const ts = Date.now();
        const username = 'nsfix_' + ts;

        // Register user
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

        // Open settings → Notifications tab
        await page.click('#settings-btn');
        await page.waitForTimeout(500);
        await page.click('.settings-tab[data-tab="notification-settings"]');
        await page.waitForTimeout(300);

        // Upload WAV notification sound via the UI (triggers syncNotificationSoundToServer)
        const wavBuffer = makeMinimalWav();
        await page.locator('#notif-sound-input').setInputFiles({
            name: 'testfix.wav',
            mimeType: 'audio/wav',
            buffer: wavBuffer,
        });
        await page.waitForTimeout(2000);

        // Verify upload success in UI
        await expect(page.locator('#notif-sound-file-name')).toBeVisible();
        const fileNameText = await page.locator('#notif-sound-file-name').textContent();
        expect(fileNameText).toContain('testfix.wav');

        // Get token from browser context for API call
        const tokenNss = await page.evaluate(() => localStorage.getItem('token'));

        // Fetch the notification sound from the server API
        const soundRes = await page.request.get(`${BASE}/api/notification-sound`, {
            headers: { Authorization: 'Bearer ' + tokenNss },
        });
        expect(soundRes.ok()).toBe(true);
        const soundData = await soundRes.json();

        // Verify sender_public_key is present and valid
        expect(soundData.sender_public_key).toBeTruthy();
        expect(typeof soundData.sender_public_key).toBe('string');
        expect(soundData.sender_public_key.length).toBeGreaterThan(0);

        // Verify it decodes as valid base64 (X25519 public key = 32 bytes)
        const decodedLen = await page.evaluate((b64: string) => {
            try {
                const bytes = E2ECrypto.base64ToArrayBuffer(b64);
                return bytes.byteLength;
            } catch (e) {
                return -1;
            }
        }, soundData.sender_public_key);
        expect(decodedLen).toBe(32);

        // Verify it matches the identity public key (not an ephemeral key)
        const matchesIdentity = await page.evaluate((b64: string) => {
            const storedKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(b64));
            const identityPub = E2ECrypto.getIdentityKeyPair().publicKey;
            if (storedKey.length !== identityPub.length) return false;
            for (let i = 0; i < storedKey.length; i++) {
                if (storedKey[i] !== identityPub[i]) return false;
            }
            return true;
        }, soundData.sender_public_key);
        expect(matchesIdentity).toBe(true);
    });

    test('rotated key entry is decryptable via sender_public_key after local key removal', async ({ page }) => {
        const ts = Date.now();
        const username = 'rotdec_' + ts;

        // Register user
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // Create server
        const inviteCode = generateCode(8);
        const srvRes = await page.request.post(`${BASE}/api/servers`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { name: 'RotDec ' + ts, invite_code_hash: sha256Hex(inviteCode) },
        });
        const server = await srvRes.json();
        expect(server.id).toBeTruthy();

        // Upload initial key for owner (using old envelopeEncryptRaw with ephemeral key)
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
        }, { serverId: server.id, userId: body.user.id });

        // Generate invite so server has members
        await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
            headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
            data: { invite_code_hash: sha256Hex(inviteCode) },
        });

        // Rotate the server key — this uploads new key entries with identity.publicKey (the fix)
        const rotOk = await page.evaluate(async (serverId: string) => {
            try {
                return await rotateServerKey(serverId);
            } catch (e) {
                return false;
            }
        }, server.id);
        expect(rotOk).toBe(true);

        // Remove the local server key — this simulates what happens when a user
        // logs in on a new device and needs to fetch+decrypt the key from the server
        await page.evaluate((serverId: string) => {
            E2ECrypto.removeServerKey(serverId);
        }, server.id);

        // Now simulate what fetchAndDecryptServerKey does: fetch all key entries,
        // try to decrypt each using envelopeDecrypt with the stored sender_public_key.
        // If the rotateServerKey fix works, the entry it uploaded (with identity.publicKey
        // as sender_public_key) should decrypt successfully.
        const decrypted = await page.evaluate(async (serverId: string) => {
            try {
                const res = await fetch(`/api/servers/${serverId}/keys`, {
                    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
                });
                const keys = await res.json();
                if (!Array.isArray(keys) || keys.length === 0) return 'no keys';

                const identity = E2ECrypto.getIdentityKeyPair();
                if (!identity) return 'no identity';

                for (const entry of keys) {
                    try {
                        const serverKey = E2ECrypto.envelopeDecrypt(
                            entry.encrypted_key,
                            identity.privateKey,
                            new Uint8Array(E2ECrypto.base64ToArrayBuffer(entry.sender_public_key)),
                            entry.nonce
                        );
                        if (serverKey && serverKey.length > 0) {
                            E2ECrypto.saveServerKey(serverId, serverKey);
                            return 'success';
                        }
                    } catch (e) {
                        continue;
                    }
                }
                return 'all entries failed';
            } catch (e: any) {
                return 'error: ' + e.message;
            }
        }, server.id);

        expect(decrypted).toBe('success');
    });
});
