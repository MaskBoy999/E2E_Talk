import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
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

async function loginUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

// Snapshot the recoverable key material a device currently holds locally.
async function keySnapshot(page: any) {
    return await page.evaluate(() => {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const kp = E2ECrypto.getIdentityKeyPair(user.id);
        const serverKeys: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i) as string;
            if (k.indexOf('e2e_server_') === 0) serverKeys[k] = localStorage.getItem(k) as string;
        }
        return {
            identityPub: kp ? E2ECrypto.arrayBufferToBase64(kp.publicKey) : null,
            friendCode: localStorage.getItem('e2e_friend_code'),
            hmacKey: localStorage.getItem('e2e_hmac_key'),
            authKey: localStorage.getItem('e2e_auth_key'),
            serverKeys,
            profileKeyCache: localStorage.getItem('profile_key_cache'),
        };
    });
}

test('blob survives multi-device write-back: register A → login B (re-saves) → fresh C recovers the full bundle', async ({ browser }) => {
    const ts = Date.now();
    const username = 'blob_md_' + ts;

    // Device A: register + create a server (so a server key exists) + save the blob.
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await ctxA.newPage();
    const a = await registerUser(pageA, username);

    // Create a server via API so a server key lands in the bundle.
    const inviteCode = 'code' + ts;
    const createRes = await pageA.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
        data: { name: 'BlobSrv_' + ts, invite_code: inviteCode },
    });
    expect(createRes.ok()).toBeTruthy();
    const serverData = await createRes.json();
    const serverId = serverData.id;

    // Generate + save + upload the server key (mirrors chat.js createServer).
    const keySetup = await pageA.evaluate(async ({ serverId, token }: { serverId: string; token: string }) => {
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
            }),
        });
        return { ok: res.ok };
    }, { serverId, token: a.token });
    expect(keySetup.ok).toBeTruthy();

    // Give the debounced save a moment, then force a fresh save so the bundle
    // definitely contains the server key.
    await pageA.waitForTimeout(3500);
    await pageA.evaluate(() => { try { saveKeyBlobToServer(); } catch (_) {} });
    await pageA.waitForTimeout(800);

    const snapA = await keySnapshot(pageA);
    expect(snapA.identityPub).toBeTruthy();
    expect(snapA.friendCode).toBeTruthy();
    expect(snapA.serverKeys[`e2e_server_${serverId}`]).toBeTruthy();
    expect(snapA.authKey).toBeTruthy();
    expect(snapA.hmacKey).toBeTruthy();

    // Device B: fresh login — the blob is restored AND re-saved by the login
    // handler (multi-device write-back path). Verify B holds the same identity.
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageB = await ctxB.newPage();
    const b = await loginUser(pageB, username);
    const snapB = await keySnapshot(pageB);
    expect(snapB.identityPub).toBe(snapA.identityPub); // same identity, not a new one
    expect(snapB.serverKeys[`e2e_server_${serverId}`]).toBe(snapA.serverKeys[`e2e_server_${serverId}`]);

    // Device B explicitly re-saves the blob (simulates any later save from B).
    await pageB.evaluate(() => { try { saveKeyBlobToServer(); } catch (_) {} });
    await pageB.waitForTimeout(800);

    // Device C: another fresh login — must recover the FULL bundle that B wrote
    // back, including the server key and friend code.
    const ctxC = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageC = await ctxC.newPage();
    const c = await loginUser(pageC, username);
    const snapC = await keySnapshot(pageC);
    expect(snapC.identityPub).toBe(snapA.identityPub);
    expect(snapC.friendCode).toBe(snapA.friendCode);
    expect(snapC.hmacKey).toBe(snapA.hmacKey);
    expect(snapC.authKey).toBeTruthy();
    expect(snapC.serverKeys[`e2e_server_${serverId}`]).toBe(snapA.serverKeys[`e2e_server_${serverId}`]);

    // The server-side blob (as fetched by C's own login) decrypts to a COMPLETE
    // bundle: identity, friend code, hmac, and the server key all present.
    const stored = await pageC.evaluate(async () => {
        const res = await fetch('/api/key-blob', {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const data = await res.json();
        const bundle = E2ECrypto.decryptKeyBundle(data.encrypted_blob, 'password123', data.salt, data.nonce);
        const keys: Record<string, string> = {};
        for (const k in bundle) {
            if (k !== 'v' && bundle[k] != null && (k as string).indexOf('e2e_server_') === 0) keys[k] = bundle[k];
        }
        return {
            hasIdentity: !!bundle['e2e_identity_private_' + (JSON.parse(localStorage.getItem('user') || '{}').id)],
            friendCode: bundle['e2e_friend_code'],
            hmacKey: bundle['e2e_hmac_key'],
            serverKeys: keys,
            version: bundle.v,
        };
    });
    expect(stored.hasIdentity).toBe(true);
    expect(stored.friendCode).toBe(snapA.friendCode);
    expect(stored.hmacKey).toBe(snapA.hmacKey);
    expect(stored.serverKeys[`e2e_server_${serverId}`]).toBe(snapA.serverKeys[`e2e_server_${serverId}`]);
    expect(stored.version).toBe(2);

    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
});
