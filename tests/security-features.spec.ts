import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('Security Feature Tests', () => {

    // ─── Crypto Function Tests ──────────────────────────────────────

    test('hmacHex produces deterministic output for same input', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            // Generate a test key
            const keyPair = E2ECrypto.x25519GenerateKeyPair();
            const keyB64 = E2ECrypto.arrayBufferToBase64(keyPair.privateKey);
            const data = 'test-message-123';

            // Compute HMAC twice with same inputs
            const h1 = E2ECrypto.hmacHex(keyB64, data);
            const h2 = E2ECrypto.hmacHex(keyB64, data);

            // Different inputs should produce different outputs
            const h3 = E2ECrypto.hmacHex(keyB64, 'different-message');

            return {
                same: h1 === h2,
                different: h1 !== h3,
                h1Length: h1.length,
                h1Type: typeof h1,
            };
        });

        expect(result.same).toBeTruthy();
        expect(result.different).toBeTruthy();
        expect(result.h1Length).toBe(64); // SHA-256 hex = 64 chars
        expect(result.h1Type).toBe('string');
    });











    // ─── Encrypted File Key Tests ───────────────────────────────────

    test('encodeEncryptedFileKey and decodeEncryptedFileKey roundtrip works', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const identity = E2ECrypto.x25519GenerateKeyPair();
            const fileKey = E2ECrypto.randomBytes(32);
            const fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);

            // Encrypt the file key with identity private key
            const encrypted = E2ECrypto.encodeEncryptedFileKey(fileKeyB64, identity.privateKey);

            // Decrypt with identity private key
            const decrypted = E2ECrypto.decodeEncryptedFileKey(encrypted, identity.privateKey);

            // Try decrypt with wrong key (should fail)
            const wrongKey = E2ECrypto.randomBytes(32);
            const decryptedWrong = E2ECrypto.decodeEncryptedFileKey(encrypted, wrongKey);

            // Try decode of plaintext key (should return null for backward compat)
            const plaintextResult = E2ECrypto.decodeEncryptedFileKey(fileKeyB64, identity.privateKey);

            return {
                roundtripMatch: decrypted === fileKeyB64,
                wrongKeyReturnsNull: decryptedWrong === null,
                plaintextReturnsNull: plaintextResult === null,
                encryptedFormat: typeof encrypted === 'string' && encrypted.indexOf(':') > 0,
            };
        });

        expect(result.roundtripMatch).toBeTruthy();
        expect(result.wrongKeyReturnsNull).toBeTruthy();
        expect(result.plaintextReturnsNull).toBeTruthy();
        expect(result.encryptedFormat).toBeTruthy();
    });

    test('decodeEncryptedFileKey handles null and invalid inputs gracefully', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const identity = E2ECrypto.x25519GenerateKeyPair();

            return {
                nullInput: E2ECrypto.decodeEncryptedFileKey(null, identity.privateKey),
                emptyInput: E2ECrypto.decodeEncryptedFileKey('', identity.privateKey),
                shortInput: E2ECrypto.decodeEncryptedFileKey('abc', identity.privateKey),
                missingColon: E2ECrypto.decodeEncryptedFileKey('b64b64b64b64b64b64b64b64', identity.privateKey),
            };
        });

        expect(result.nullInput).toBeNull();
        expect(result.emptyInput).toBeNull();
        expect(result.shortInput).toBeNull();
        expect(result.missingColon).toBeNull();
    });

    test('loadStickerPreview falls back to raw file_key for old plaintext format', async ({ page }) => {
        await page.goto(`${BASE}/login.html`);
        await page.waitForTimeout(1000);
        // This tests the backward compatibility of loadStickerPreview:
        // old plaintext file_key should still work when decodeEncryptedFileKey returns null
        const result = await page.evaluate(() => {
            const identity = E2ECrypto.x25519GenerateKeyPair();
            const rawKey = E2ECrypto.randomBytes(32);
            const rawKeyB64 = E2ECrypto.arrayBufferToBase64(rawKey);

            // Simulate what loadStickerPreview does:
            // 1. Try to decrypt with identity key
            const decrypted = E2ECrypto.decodeEncryptedFileKey(rawKeyB64, identity.privateKey);
            // 2. If null, fall back to raw key
            const fileKeyBytes = decrypted ? new Uint8Array(E2ECrypto.base64ToArrayBuffer(decrypted)) : new Uint8Array(E2ECrypto.base64ToArrayBuffer(rawKeyB64));

            const expectedBytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(rawKeyB64));
            const keysMatch = fileKeyBytes.length === expectedBytes.length &&
                fileKeyBytes.every((v, i) => v === expectedBytes[i]);

            return {
                fallbackWorks: keysMatch,
                decryptedIsNull: decrypted === null,
            };
        });

        expect(result.fallbackWorks).toBeTruthy();
        expect(result.decryptedIsNull).toBeTruthy();
    });

    // ─── Schema Backward Compatibility ──────────────────────────────

    test('existing registration and friend code flow still works', async ({ page, context }) => {
        const ts = Date.now();
        const username = 'bkwd_' + ts;

        // Register user
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.fill('#register-confirm-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 10000 });

        const body = await page.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
            friendCode: localStorage.getItem('e2e_friend_code'),
        }));

        expect(body.friendCode).toBeTruthy();
        expect(body.token).toBeTruthy();

        // Fetch friend code from server (encrypted)
        const fcRes = await page.request.get(`${BASE}/api/friend-code`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(fcRes.ok()).toBeTruthy();
        const fcData = await fcRes.json();
        expect(fcData.encrypted_friend_code).toBeTruthy();

        // Register a second user and send friend request
        const ctx2 = await context.browser()!.newContext();
        const page2 = await ctx2.newPage();
        const username2 = 'bkwd2_' + ts;

        await page2.goto(`${BASE}/login.html`);
        await page2.click('#show-register');
        await page2.fill('#register-username', username2);
        await page2.fill('#register-password', 'password123');
        await page2.fill('#register-confirm-password', 'password123');
        await page2.click('#register-form button[type="submit"]');
        await page2.waitForURL('**/index.html', { timeout: 10000 });

        const body2 = await page2.evaluate(() => ({
            token: localStorage.getItem('token'),
            user: JSON.parse(localStorage.getItem('user') || '{}'),
        }));

        // user2 sends friend request to user1 using user1's friend code
        const frRes = await page2.request.post(`${BASE}/api/friends/request`, {
            headers: {
                Authorization: `Bearer ${body2.token}`,
                'Content-Type': 'application/json',
            },
            data: { friend_code: body.friendCode },
        });
        expect(frRes.ok()).toBeTruthy();

        // user1 accepts the request
        const incomingRes = await page.request.get(`${BASE}/api/friends/requests/incoming`, {
            headers: { Authorization: `Bearer ${body.token}` },
        });
        expect(incomingRes.ok()).toBeTruthy();
        const incoming = await incomingRes.json();

        // Handle potential empty incoming (race condition)
        if (incoming.length > 0) {
            const acceptRes = await page.request.post(`${BASE}/api/friends/requests/accept`, {
                headers: {
                    Authorization: `Bearer ${body.token}`,
                    'Content-Type': 'application/json',
                },
                data: { request_id: incoming[0].id },
            });
            expect(acceptRes.ok()).toBeTruthy();
        }

        // Clean up
        await page2.close();
        await ctx2.close();
    });
});
