import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// --- Pure-JS TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30s) for 2FA assertions ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(s: string): Uint8Array {
    const out: number[] = [];
    let buffer = 0, bits = 0;
    for (const c of s.trim().toUpperCase()) {
        const v = B32.indexOf(c);
        if (v < 0) continue;
        buffer = (buffer << 5) | v;
        bits += 5;
        if (bits >= 8) { bits -= 8; out.push((buffer >> bits) & 0xff); }
    }
    return new Uint8Array(out);
}

function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
    function sha1(m: Uint8Array): Uint8Array {
        const ml = m.length;
        const msgWithPad = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
        msgWithPad.set(m);
        msgWithPad[ml] = 0x80;
        const dv = new DataView(msgWithPad.buffer);
        dv.setUint32(msgWithPad.length - 4, ml * 8, false);
        let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
        const w = new Uint32Array(80);
        for (let i = 0; i < msgWithPad.length; i += 64) {
            for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
            for (let j = 16; j < 80; j++) {
                const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
                w[j] = (n << 1) | (n >>> 31);
            }
            let a = h0, b = h1, c = h2, d = h3, e = h4;
            for (let j = 0; j < 80; j++) {
                let f: number, k: number;
                if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
                else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
                else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
                else { f = b ^ c ^ d; k = 0xCA62C1D6; }
                const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
                e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
        }
        const out = new Uint8Array(20);
        const ov = new DataView(out.buffer);
        ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
        ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
        return out;
    }
    const block = new Uint8Array(64).fill(0);
    if (key.length > 64) block.set(sha1(key).slice(0, 64)); else block.set(key);
    const ipad = block.map((b) => b ^ 0x36);
    const opad = block.map((b) => b ^ 0x5c);
    const inner = new Uint8Array(ipad.length + msg.length);
    inner.set(ipad); inner.set(msg, ipad.length);
    const innerHash = sha1(inner);
    const outer = new Uint8Array(opad.length + innerHash.length);
    outer.set(opad); outer.set(innerHash, opad.length);
    return sha1(outer);
}

function totpCode(secretB32: string): string {
    const time = Math.floor(Date.now() / 1000);
    const counter = Math.floor(time / 30);
    const msg = new Uint8Array(8);
    const dv = new DataView(msg.buffer);
    dv.setUint32(4, counter >>> 0, false);
    dv.setUint32(0, Math.floor(counter / 0x100000000), false);
    const mac = hmacSha1(base32Decode(secretB32), msg);
    const offset = mac[19] & 0x0f;
    const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

// Register a fresh user via the UI (identity keys + token) and return the token.
async function registerUser(page: any, uname: string, password = 'password123') {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.fill('#register-username', uname);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { timeout: 10000 });
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();
    return { token: token as string };
}

// Log in via the UI (which computes the client-side hash automatically).
async function loginUser(page: any, username: string, password: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-username', { timeout: 10000 });
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { timeout: 10000 });
}

// Confirm the password-change confirmation modal (Cancel would abort).
async function confirmPasswordChange(page: any) {
    await page.waitForSelector('#change-pw-confirm-modal', { state: 'visible', timeout: 5000 });
    await page.click('#change-pw-confirm-yes');
}

// Drive the Settings → Security → Change Password UI to completion (form
// validation passes → confirmation modal → yes → change executes).
async function changePasswordViaUi(page: any, oldPw: string, newPw: string) {
    await page.click('#settings-btn');
    await page.click('.settings-tab[data-tab="security-settings"]');
    await page.waitForSelector('#change-pw-btn');
    await page.click('#change-pw-btn');
    await page.fill('#change-pw-current', oldPw);
    await page.fill('#change-pw-new', newPw);
    await page.fill('#change-pw-confirm', newPw);
    await page.click('#change-pw-confirm-btn');
    await confirmPasswordChange(page);
    await page.waitForFunction(() => {
        const el = document.getElementById('change-pw-status');
        return el && el.textContent && el.textContent.includes('Password changed');
    }, undefined, { timeout: 20000 });
}

// Compute the client-side login hash (same as auth.js) inside the page context.
async function loginHash(page: any, username: string, password: string): Promise<string> {
    return page.evaluate(async ({ username, password }) => {
        const res = await fetch('/api/auth-params/' + encodeURIComponent(username));
        const params = await res.json();
        if (params.encrypted_hash_key && params.hash_key_salt && params.hash_key_nonce) {
            const hashKeyB64 = E2ECrypto.decryptWithPassword(
                params.encrypted_hash_key, password, params.hash_key_salt, params.hash_key_nonce
            );
            if (hashKeyB64) {
                const bytes = new Uint8Array(E2ECrypto.base64ToArrayBuffer(hashKeyB64));
                return E2ECrypto.hmacHex(bytes, password);
            }
        }
        return password; // legacy fallback
    }, { username, password });
}

async function apiLogin(page: any, username: string, hash: string) {
    return page.request.post(`${BASE}/api/login`, {
        headers: { 'Content-Type': 'application/json' },
        data: { username, password: hash, duration_seconds: 3600 },
    });
}

test('basic flow: wrong current rejected, old login intact, then new password works and old fails', async ({ page }) => {
    const ts = Date.now();
    const uname = 'pw_' + ts;
    const oldPw = 'password123';
    const newPw = 'newPassword456';
    const { token } = await registerUser(page, uname, oldPw);
    expect(token).toBeTruthy();

    // Open Settings → Security tab.
    await page.click('#settings-btn');
    await page.click('.settings-tab[data-tab="security-settings"]');
    await page.waitForSelector('#change-pw-btn');

    // 1. Attempt with a WRONG current password → confirmation modal appears,
    //    confirming still fails server-side with an error, nothing changes.
    await page.click('#change-pw-btn');
    await page.fill('#change-pw-current', 'wrong-current');
    await page.fill('#change-pw-new', newPw);
    await page.fill('#change-pw-confirm', newPw);
    await page.click('#change-pw-confirm-btn');
    await confirmPasswordChange(page);
    await page.waitForFunction(() => {
        const el = document.getElementById('change-pw-status');
        return el && el.textContent && el.textContent.toLowerCase().includes('incorrect');
    }, undefined, { timeout: 15000 });

    // Old password must still log in after the failed attempt.
    let oldHash = await loginHash(page, uname, oldPw);
    let res = await apiLogin(page, uname, oldHash);
    expect(res.status()).toBe(200);

    // 2. Mismatched confirmation → client-side error, nothing sent.
    await page.fill('#change-pw-current', oldPw);
    await page.fill('#change-pw-new', newPw);
    await page.fill('#change-pw-confirm', 'different-confirm');
    await page.click('#change-pw-confirm-btn');
    await page.waitForFunction(() => {
        const el = document.getElementById('change-pw-status');
        return el && el.textContent && el.textContent.toLowerCase().includes('do not match');
    }, undefined, { timeout: 5000 });

    // 2.5 Cancelling the confirmation modal aborts the change: the modal
    //    closes, nothing is submitted, and the old password still works.
    await page.fill('#change-pw-current', oldPw);
    await page.fill('#change-pw-new', newPw);
    await page.fill('#change-pw-confirm', newPw);
    await page.click('#change-pw-confirm-btn');
    await page.waitForSelector('#change-pw-confirm-modal', { state: 'visible', timeout: 5000 });
    await page.click('#change-pw-confirm-cancel');
    await page.waitForSelector('#change-pw-confirm-modal', { state: 'hidden', timeout: 5000 });
    const statusAfterCancel = await page.evaluate(() => {
        const el = document.getElementById('change-pw-status');
        return el ? el.textContent : '';
    });
    expect(statusAfterCancel.includes('Password changed')).toBe(false);
    oldHash = await loginHash(page, uname, oldPw);
    res = await apiLogin(page, uname, oldHash);
    expect(res.status()).toBe(200);

    // 3. Real change with the correct current password (through the confirmation).
    await page.fill('#change-pw-confirm', newPw);
    await page.click('#change-pw-confirm-btn');
    await confirmPasswordChange(page);
    await page.waitForFunction(() => {
        const el = document.getElementById('change-pw-status');
        return el && el.textContent && el.textContent.includes('Password changed');
    }, undefined, { timeout: 20000 });

    // 4. New password logs in (no 2FA required for a fresh account).
    const newHash = await loginHash(page, uname, newPw);
    res = await apiLogin(page, uname, newHash);
    expect(res.status()).toBe(200);
    const newData = await res.json();
    expect(newData.token).toBeTruthy();
    expect(newData.two_factor_required).toBeFalsy();

    // 5. Old password is rejected.
    oldHash = await loginHash(page, uname, oldPw);
    res = await apiLogin(page, uname, oldHash);
    expect(res.status()).toBe(401);
});

test('change keeps the session, identity keys and key blob intact; reauth works with new password', async ({ page }) => {
    const ts = Date.now();
    const uname = 'pwkeep_' + ts;
    const oldPw = 'password123';
    const newPw = 'newPassword456';
    const { token } = await registerUser(page, uname, oldPw);

    const identityBefore = await page.evaluate(() => {
        const kp = E2ECrypto.getIdentityKeyPair();
        return kp ? {
            pub: E2ECrypto.arrayBufferToBase64(kp.publicKey),
            priv: E2ECrypto.arrayBufferToBase64(kp.privateKey),
        } : null;
    });
    expect(identityBefore).toBeTruthy();

    await changePasswordViaUi(page, oldPw, newPw);

    // 1. The existing session token still works after the change.
    const statusRes = await page.request.get(`${BASE}/api/2fa/status`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    expect(statusRes.status()).toBe(200);

    // 2. Identity keys are untouched — same public AND private key.
    const identityAfter = await page.evaluate(() => {
        const kp = E2ECrypto.getIdentityKeyPair();
        return kp ? {
            pub: E2ECrypto.arrayBufferToBase64(kp.publicKey),
            priv: E2ECrypto.arrayBufferToBase64(kp.privateKey),
        } : null;
    });
    expect(identityAfter).toEqual(identityBefore);

    // 3. The key blob is now wrapped with the NEW password only: it must
    //    decrypt with the new password (and contain the identity key) but not
    //    with the old one.
    const blobCheck = await page.evaluate(async ({ token, newPw, oldPw }) => {
        const res = await fetch('/api/key-blob', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return { error: 'status ' + res.status };
        const data = await res.json();
        const withNew = E2ECrypto.decryptKeyBundle(data.encrypted_blob, newPw, data.salt, data.nonce);
        const withOld = E2ECrypto.decryptKeyBundle(data.encrypted_blob, oldPw, data.salt, data.nonce);
        const hasIdentity = !!(withNew && Object.keys(withNew).some(k => k.indexOf('e2e_identity_private_') === 0));
        return { withNew: !!withNew, withOld: !!withOld, hasIdentity };
    }, { token, newPw, oldPw });
    expect(blobCheck.error).toBeUndefined();
    expect(blobCheck.withNew).toBe(true);
    expect(blobCheck.hasIdentity).toBe(true);
    expect(blobCheck.withOld).toBe(false);

    // 4. Re-authentication (Settings → Security → Re-authenticate) works with
    //    the NEW password — proves the stored hash + hash_key stayed consistent.
    const newHash = await loginHash(page, uname, newPw);
    const reauthRes = await page.request.post(`${BASE}/api/reauth`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { password: newHash, duration_seconds: 3600 },
    });
    expect(reauthRes.status()).toBe(200);
    const reauthData = await reauthRes.json();
    expect(reauthData.token).toBeTruthy();
});

test('password change signs out all other devices; re-login with the NEW password recovers identity + friend code', async ({ browser }) => {
    const ts = Date.now();
    const uname = 'pwdev_' + ts;
    const oldPw = 'password123';
    const newPw = 'newPassword456';

    // Device 1: register + capture identity + friend code + token.
    const ctx1 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page1 = await ctx1.newPage();
    const { token: token1 } = await registerUser(page1, uname, oldPw);
    expect(token1).toBeTruthy();

    const identity1 = await page1.evaluate(() => {
        const kp = E2ECrypto.getIdentityKeyPair();
        return kp ? E2ECrypto.arrayBufferToBase64(kp.publicKey) : null;
    });
    expect(identity1).toBeTruthy();
    const fc1 = await page1.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc1).toBeTruthy();

    // Device 2 (fresh context): signed in BEFORE the change, with the OLD password.
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
    const page2 = await ctx2.newPage();
    await loginUser(page2, uname, oldPw);
    const token2 = await page2.evaluate(() => localStorage.getItem('token'));
    expect(token2).toBeTruthy();

    // Device 2's session is valid right now.
    let statusRes = await page2.request.get(`${BASE}/api/2fa/status`, {
        headers: { Authorization: `Bearer ${token2}` },
    });
    expect(statusRes.status()).toBe(200);

    // Device 1 changes the password → all OTHER sessions are revoked.
    await changePasswordViaUi(page1, oldPw, newPw);

    // Device 2's old token is now rejected (signed out everywhere).
    statusRes = await page2.request.get(`${BASE}/api/2fa/status`, {
        headers: { Authorization: `Bearer ${token2}` },
    });
    expect(statusRes.status()).toBe(401);

    // Device 1's own session still works.
    statusRes = await page1.request.get(`${BASE}/api/2fa/status`, {
        headers: { Authorization: `Bearer ${token1}` },
    });
    expect(statusRes.status()).toBe(200);

    // Device 2 signs in again with the NEW password.
    await page2.goto(`${BASE}/login.html`);
    await loginUser(page2, uname, newPw);

    // The identity is recovered from the key blob (decrypted with the new
    // password) — same public key as device 1.
    await page2.waitForFunction(() => E2ECrypto.getIdentityKeyPair() !== null, undefined, { timeout: 15000 });
    const identity2 = await page2.evaluate(() => {
        const kp = E2ECrypto.getIdentityKeyPair();
        return kp ? E2ECrypto.arrayBufferToBase64(kp.publicKey) : null;
    });
    expect(identity2).toBe(identity1);

    // The friend code is recovered too.
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    expect(fc2).toBe(fc1);
});

test('2FA keeps working after a password change', async ({ page }) => {
    const ts = Date.now();
    const uname = 'pw2fa_' + ts;
    const oldPw = 'password123';
    const newPw = 'newPassword456';
    const { token } = await registerUser(page, uname, oldPw);

    // Enroll 2FA with the current password.
    const hashOld = await loginHash(page, uname, oldPw);
    const enrollRes = await page.request.post(`${BASE}/api/2fa/enroll`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { password: hashOld },
    });
    expect(enrollRes.status()).toBe(200);
    const enroll = await enrollRes.json();
    expect(enroll.secret_base32).toBeTruthy();
    const secret = enroll.secret_base32;

    // Complete enrollment with a valid TOTP code so 2FA is actually ON.
    let res = await page.request.post(`${BASE}/api/2fa/verify-enroll`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: totpCode(secret) },
    });
    expect(res.status()).toBe(200);
    const enrolled = await res.json();
    expect(enrolled.enabled).toBe(true);

    // Change the password while 2FA is enabled.
    await changePasswordViaUi(page, oldPw, newPw);

    // New password passes the password step, then the TOTP code completes login.
    const hashNew = await loginHash(page, uname, newPw);
    res = await apiLogin(page, uname, hashNew);
    expect(res.status()).toBe(200);
    const step = await res.json();
    expect(step.two_factor_required).toBe(true);
    expect(step.pending_token).toBeTruthy();

    res = await page.request.post(`${BASE}/api/login/2fa`, {
        headers: { 'Content-Type': 'application/json' },
        data: { pending_token: step.pending_token, code: totpCode(secret) },
    });
    expect(res.status()).toBe(200);
    const final = await res.json();
    expect(final.token).toBeTruthy();

    // Old password is now rejected at the password step.
    const hashOldAfter = await loginHash(page, uname, oldPw);
    res = await apiLogin(page, uname, hashOldAfter);
    expect(res.status()).toBe(401);
});
