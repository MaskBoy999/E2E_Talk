import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.describe('S7: Secure memory erasure', () => {

    test('E2ECrypto.secureZero zeroes a Uint8Array', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            // Create a buffer with known sensitive data
            const buf = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x42, 0x13, 0x37, 0xFF]);
            const original = Array.from(buf);

            // Verify it has data
            const before = Array.from(buf);

            // Zero it
            E2ECrypto.secureZero(buf);

            // Read back
            const after = Array.from(buf);

            return { before, after, original };
        });

        // Before zeroing, buffer should have the original data
        expect(result.before).toEqual(result.original);
        // After zeroing, all bytes should be 0
        expect(result.after).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    test('E2ECrypto.secureZero handles null/undefined gracefully', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            // Should not throw
            E2ECrypto.secureZero(null);
            E2ECrypto.secureZero(undefined);
            E2ECrypto.secureZero(new Uint8Array(0));
            return true;
        });
        expect(result).toBe(true);
    });

    test('E2ECrypto.secureZero works on ArrayBuffer', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const ab = new ArrayBuffer(8);
            const view = new Uint8Array(ab);
            view.set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
            const before = Array.from(view);

            E2ECrypto.secureZero(ab);
            const after = Array.from(new Uint8Array(ab));

            return { before, after };
        });

        expect(result.before).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(result.after).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    test('encrypt/decrypt with password still works after zeroing changes', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            // Test that encryptWithPassword / decryptWithPassword still work
            // (these now zero intermediate buffers internally)
            const plaintext = 'sensitive data that must survive the round trip';
            const password = 'test-password-123';

            const encrypted = E2ECrypto.encryptWithPassword(plaintext, password);
            const decrypted = E2ECrypto.decryptWithPassword(
                encrypted.encrypted_private_key,
                password,
                encrypted.salt,
                encrypted.nonce
            );

            return { encrypted: !!encrypted, decrypted };
        });

        expect(result.encrypted).toBe(true);
        expect(result.decrypted).toBe('sensitive data that must survive the round trip');
    });

    test('key bundle encrypt/decrypt still works after zeroing changes', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const bundle = { v: 3, test_key: 'test_value_12345' };
            const password = 'bundle-password';

            const encrypted = E2ECrypto.encryptKeyBundle(bundle, password);
            const decrypted = E2ECrypto.decryptKeyBundle(
                encrypted.encrypted_private_key,
                password,
                encrypted.salt,
                encrypted.nonce
            );

            return { encrypted: !!encrypted, decrypted };
        });

        expect(result.encrypted).toBe(true);
        expect(result.decrypted).toEqual({ v: 3, test_key: 'test_value_12345' });
    });

    test('key escrow encrypt/decrypt still works after zeroing changes', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            // Generate a keypair, encrypt private key for escrow, decrypt it
            const kp = E2ECrypto.generateIdentityKeyPair();
            const privB64 = E2ECrypto.arrayBufferToBase64(kp.privateKey);
            const password = 'escrow-password';

            const escrowed = E2ECrypto.encryptKeyForEscrow(privB64, password);
            const recovered = E2ECrypto.decryptKeyFromEscrow(
                escrowed.encrypted_private_key,
                password,
                escrowed.salt,
                escrowed.nonce
            );

            return { escrowed: !!escrowed, recovered, matchesOriginal: recovered === privB64 };
        });

        expect(result.escrowed).toBe(true);
        expect(result.matchesOriginal).toBe(true);
    });

    test('DM key derivation and encryption still works', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const alice = E2ECrypto.generateIdentityKeyPair();
            const bob = E2ECrypto.generateIdentityKeyPair();
            const dmChannelId = 'test-dm-channel-123';

            const encrypted = E2ECrypto.encryptDm('hello dm', dmChannelId, alice.privateKey, bob.publicKey);
            const decrypted = E2ECrypto.decryptDm(encrypted.ciphertext, encrypted.nonce, dmChannelId, bob.privateKey, alice.publicKey);

            return { encrypted: !!encrypted, decrypted };
        });

        expect(result.encrypted).toBe(true);
        expect(result.decrypted).toBe('hello dm');
    });

    test('envelope encrypt/decrypt still works', async ({ page }) => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForTimeout(1000);

        const result = await page.evaluate(() => {
            const sender = E2ECrypto.generateIdentityKeyPair();
            const recipient = E2ECrypto.generateIdentityKeyPair();

            const encrypted = E2ECrypto.envelopeEncrypt('secret message', recipient.publicKey, sender.privateKey);
            const decBuf = E2ECrypto.envelopeDecrypt(encrypted.ciphertext, recipient.privateKey, sender.publicKey, encrypted.nonce);
            const decrypted = decBuf ? new TextDecoder().decode(decBuf) : null;

            return { encrypted: !!encrypted, decrypted };
        });

        expect(result.encrypted).toBe(true);
        expect(result.decrypted).toBe('secret message');
    });
});
