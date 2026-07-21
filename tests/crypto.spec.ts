import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test('crypto round-trips work perfectly with auth ECDH and AAD', async ({ page }) => {
    await page.goto(`${BASE}/test-crypto.html`);

    // Wait for the test results to appear
    await page.waitForSelector('.result', { timeout: 20000 });

    // Report any failures
    const failElements = await page.locator('.result.fail').allTextContents();
    if (failElements.length > 0) {
        console.log('FAILURES:', JSON.stringify(failElements));
    }
    expect(failElements).toHaveLength(0);

    // Check the summary says all passed
    const summaryText = await page.locator('.summary').textContent();
    expect(summaryText).toContain('All');
    expect(summaryText).toContain('PASSED');

    // Get detailed results
    const passCount = await page.locator('.result.pass').count();
    const failCount = await page.locator('.result.fail').count();
    console.log(`Results: ${passCount} passed, ${failCount} failed`);
});

test('core crypto operations execute without errors in page context', async ({ page }) => {
    await page.goto(`${BASE}/test-crypto.html`);

    // Wait for the test results to appear
    await page.waitForSelector('.result', { timeout: 20000 });

    // Verify the page summary says all passed
    const summaryText = await page.locator('.summary').textContent();
    expect(summaryText).toContain('All');
    expect(summaryText).toContain('PASSED');

    // Check sodium status line for version info
    const statusText = await page.locator('#sodium-status').textContent();
    expect(statusText).toContain('libsodium initialized');

    // Now run specific assertions in browser context
    // We use a separate navigation to ensure clean state
    await page.goto(`${BASE}/test-crypto.html`);
    await page.waitForSelector('.result', { timeout: 20000 });

    // Verify specific operations via page.evaluate with error isolation
    const results = await page.evaluate(async () => {
        const E = globalThis.E2ECrypto;
        if (!E) return { error: 'E2ECrypto not defined' };

        try {
            const sender = E.generateIdentityKeyPair();
            const recipient = E.generateIdentityKeyPair();
            const msg = new TextEncoder().encode('hello world');

            // Envelope (Authenticated ECDH)
            const enc = E.envelopeEncrypt(msg, recipient.publicKey, sender.privateKey);
            const decRaw = E.envelopeDecrypt(enc.ciphertext, recipient.privateKey, sender.publicKey, enc.nonce);
            const decPlaintext = new TextDecoder().decode(decRaw);

            // AEAD (With AAD)
            const symKey = E.generateSymmetricKey();
            const aad = new TextEncoder().encode('frame-123');
            const aeadEnc = E.aeadEncrypt(msg, symKey, aad);
            const aeadDec = E.aeadDecrypt(aeadEnc.ciphertext, symKey, aeadEnc.nonce, aad);
            const aeadStr = new TextDecoder().decode(aeadDec);

            // HMAC consistency
            const hash1 = E.hmacHex('CODE123', 'server_hmac_key');
            const hash2 = E.hmacHex('CODE123', 'server_hmac_key');

            // Password encrypt/decrypt
            const pwEnc = E.encryptWithPassword('my-friend-code', 'mypassword');
            const pwDec = E.decryptWithPassword(pwEnc.encrypted_private_key, 'mypassword', pwEnc.salt, pwEnc.nonce);

            // Media frame
            const frameKey = E.generateSymmetricKey();
            const frameData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
            const encFrame = E.encryptMediaFrame(frameData, frameKey, 42);
            const decFrame = E.decryptMediaFrame(encFrame, frameKey, 42);

            return {
                envelope: decPlaintext === 'hello world',
                aead: aeadStr === 'hello world',
                hmac_match: hash1 === hash2 && hash1.length === 64,
                password_roundtrip: pwDec === 'my-friend-code',
                media_frame: decFrame.length === 8 && decFrame[0] === 1 && decFrame[7] === 8,
                wrong_password_fails: E.decryptWithPassword(pwEnc.encrypted_private_key, 'wrongpassword', pwEnc.salt, pwEnc.nonce) === null,
            };
        } catch (e) {
            return { error: 'Crypto operation failed: ' + e.message };
        }
    });

    expect(results.error).toBeUndefined();
    expect(results.envelope).toBe(true);
    expect(results.aead).toBe(true);
    expect(results.hmac_match).toBe(true);
    expect(results.password_roundtrip).toBe(true);
    expect(results.media_frame).toBe(true);
    expect(results.wrong_password_fails).toBe(true);
});
